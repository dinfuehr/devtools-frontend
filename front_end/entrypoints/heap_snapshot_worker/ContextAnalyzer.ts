// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type * as HeapSnapshotModel from '../../models/heap_snapshot/heap_snapshot.js';
import * as FormatterWorker from '../formatter_worker/formatter_worker.js';

import type {HeapSnapshot, HeapSnapshotNode} from './HeapSnapshot.js';

interface ScriptInfo {
  name: string;
  nodeId: number;
  sourceAnalysis: {status: 'parsed', scopes: Map<string, SourceScope>}|
      {status: 'failed', reason: 'missing-source'|'unparseable-source'};
}

interface SourceScope {
  name?: string;
  start: number;
  end: number;
  variables: Map<string, ContextVariableUse[]>;
}

interface ContextVariableUse {
  functionStart: number;
  functionEnd: number;
}

interface ScopeAccumulator {
  scopeInfoNodeIndex: number;
  scopeInfoNodeId: number;
  scriptId: number;
  scriptNodeId: number;
  scriptName: string;
  sourceScope: SourceScope;
  fieldNames: string[];
  contexts: MatchedContext[];
}

interface MatchedContext {
  contextNodeIndex: number;
  fieldValueNodeIndexes: number[];
}

interface LiveClosure {
  contextNodeIndex: number;
  scriptId: number;
  functionStart: number;
  functionEnd: number;
}

interface LiveFunction {
  scriptId: number;
  functionStart: number;
  functionEnd: number;
  contextNodeIndexes: Set<number>;
}

function rangeKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function functionKey(scriptId: number, start: number, end: number): string {
  return `${scriptId}:${start}:${end}`;
}

function findSourceScope(sourceScopes: Map<string, SourceScope>, start: number, end: number): SourceScope|undefined {
  const exactMatch = sourceScopes.get(rangeKey(start, end));
  if (exactMatch) {
    return exactMatch;
  }

  // V8 creates synthetic scopes whose start positions can point inside the construct rather than
  // at the beginning of the AST node reported by Acorn, though their end positions still match:
  // 1. Lexical loop bindings (e.g. `for (const item of ...) { ... }`), where V8's iteration scope
  //    starts at the loop binding rather than the `for` keyword.
  // 2. Catch clauses (e.g. `catch (caught) { ... }`), where V8's catch parameter scope starts at
  //    the exception variable rather than the `catch` keyword.
  // 3. Functions with parameter initializers (e.g. `function foo(param = default) { ... }`), where
  //    V8 creates a separate function body scope starting at `{` while Acorn produces a single function scope.
  // Pick the innermost containing source scope so these ScopeInfos can be correlated with the parsed source.
  let containingScope: SourceScope|undefined;
  for (const scope of sourceScopes.values()) {
    if (scope.end === end && scope.start <= start && (!containingScope || scope.start > containingScope.start)) {
      containingScope = scope;
    }
  }
  return containingScope;
}

export class ContextAnalyzer {
  readonly #snapshot: HeapSnapshot;
  readonly #node: HeapSnapshotNode;

  readonly #scripts = new Map<number, ScriptInfo>();
  readonly #scopeInfoScriptIds = new Map<number, number|undefined>();
  readonly #contextNodes: Array<{contextNodeIndex: number, contextNodeId: number, scopeInfoNodeIndex?: number}> = [];
  readonly #liveClosures: LiveClosure[] = [];

  readonly #reachableContextsByFunction = new Map<string, Set<number>>();
  #liveFunctionsByScript = new Map<number, LiveFunction[]>();

  constructor(snapshot: HeapSnapshot) {
    this.#snapshot = snapshot;
    this.#node = snapshot.createNode();
  }

  analyze(): HeapSnapshotModel.HeapSnapshotModel.ContextAnalysisResult {
    // (1) Scan the heap to parse script scopes, collect contexts and live closures, and associate function ScopeInfos
    // with scripts.
    this.#scanHeap();

    // (2) Group live closures by source function and record the context chains they can reach.
    this.#buildLiveFunctions();

    // (3) Correlate contexts and their field values with source scopes, grouping matches by ScopeInfo.
    const {scopes, unmatchedContexts} = this.#correlateContextsWithScopes();

    // (4) Classify fields per context and build the result objects.
    const scopeAnalyses = this.#classifyFields(scopes);

    // (5) Sort dead fields, contexts, and scopes, then return the analysis.
    return this.#sortAndBuildResult(scopeAnalyses, unmatchedContexts);
  }

  #scanHeap(): void {
    const node = this.#node;
    const snapshot = this.#snapshot;
    const nodes = snapshot.nodes;
    const nodeFieldCount = snapshot.nodeFieldCount;
    const nodeClosureType = snapshot.nodeClosureType;

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += nodeFieldCount) {
      node.nodeIndex = nodeIndex;
      const rawName = node.rawName();

      if (rawName.startsWith('system / Script')) {
        this.#processScript(node);
        continue;
      }
      if (snapshot.isContextObject(node)) {
        this.#contextNodes.push({
          contextNodeIndex: nodeIndex,
          contextNodeId: node.id(),
          scopeInfoNodeIndex: node.findInternalEdgeTarget('scope_info')?.nodeIndex,
        });
        continue;
      }
      if (node.rawType() === nodeClosureType) {
        this.#processClosure(node);
        continue;
      }
      if (!rawName.startsWith('system / SharedFunctionInfo')) {
        continue;
      }
      this.#processSharedFunctionInfo(node);
    }
  }

  #processScript(node: HeapSnapshotNode): void {
    const rawName = node.rawName();
    const scriptId = node.findInternalEdgeTarget('id')?.nodeValueAsInt();
    if (scriptId === undefined) {
      return;
    }
    const scriptNamePrefix = 'system / Script / ';
    const scriptInfo = {
      name: rawName.startsWith(scriptNamePrefix) ? rawName.substring(scriptNamePrefix.length) : '',
      nodeId: node.id(),
    };
    const source = node.findInternalEdgeTarget('source')?.name();
    if (source === undefined) {
      this.#scripts.set(scriptId, {
        ...scriptInfo,
        sourceAnalysis: {status: 'failed', reason: 'missing-source'},
      });
      return;
    }
    const sourceType = node.findInternalEdgeTarget('origin_is_module')?.nodeValueAsBool() ? 'module' : 'script';
    const scopeTree = FormatterWorker.ScopeParser.parseScopes(source, sourceType)?.export();
    if (!scopeTree) {
      this.#scripts.set(scriptId, {
        ...scriptInfo,
        sourceAnalysis: {status: 'failed', reason: 'unparseable-source'},
      });
      return;
    }
    const sourceScopes = new Map<string, SourceScope>();
    this.#scripts.set(scriptId, {
      ...scriptInfo,
      sourceAnalysis: {status: 'parsed', scopes: sourceScopes},
    });
    const pendingScopes = [scopeTree];
    while (pendingScopes.length > 0) {
      const scope = pendingScopes.pop();
      if (!scope) {
        continue;
      }
      sourceScopes.set(rangeKey(scope.start, scope.end), {
        name: scope.name,
        start: scope.start,
        end: scope.end,
        variables: new Map(scope.variables.map(variable => [variable.name, variable.contextUses])),
      });
      pendingScopes.push(...scope.children);
    }
  }

  #processClosure(node: HeapSnapshotNode): void {
    const sharedFunctionInfo = node.findInternalEdgeTarget('shared');
    const closureContext = node.findInternalEdgeTarget('context');
    const script = sharedFunctionInfo?.findInternalEdgeTarget('script');
    const scriptId = script?.findInternalEdgeTarget('id')?.nodeValueAsInt();
    const functionStart = sharedFunctionInfo?.findInternalEdgeTarget('start_position')?.nodeValueAsInt();
    const functionEnd = sharedFunctionInfo?.findInternalEdgeTarget('end_position')?.nodeValueAsInt();
    if (closureContext && scriptId !== undefined && functionStart !== undefined && functionEnd !== undefined) {
      this.#liveClosures.push({contextNodeIndex: closureContext.nodeIndex, scriptId, functionStart, functionEnd});
    }
  }

  #processSharedFunctionInfo(node: HeapSnapshotNode): void {
    const scopeInfo = node.findInternalEdgeTarget('name_or_scope_info');
    const script = node.findInternalEdgeTarget('script');
    if (scopeInfo?.rawName() !== 'system / ScopeInfo' || !script?.rawName().startsWith('system / Script')) {
      return;
    }
    const scriptId = script.findInternalEdgeTarget('id')?.nodeValueAsInt();
    if (scriptId === undefined) {
      return;
    }
    this.#scopeInfoScriptIds.set(scopeInfo.nodeIndex, scriptId);
  }

  #buildLiveFunctions(): void {
    const liveFunctions = new Map<string, LiveFunction>();
    const node = this.#node;
    const snapshot = this.#snapshot;

    for (const closure of this.#liveClosures) {
      const key = functionKey(closure.scriptId, closure.functionStart, closure.functionEnd);
      let liveFunction = liveFunctions.get(key);
      if (!liveFunction) {
        liveFunction = {
          scriptId: closure.scriptId,
          functionStart: closure.functionStart,
          functionEnd: closure.functionEnd,
          contextNodeIndexes: new Set(),
        };
        liveFunctions.set(key, liveFunction);
      }
      let contextNodeIndex: number|undefined = closure.contextNodeIndex;
      while (contextNodeIndex !== undefined && !liveFunction.contextNodeIndexes.has(contextNodeIndex)) {
        node.nodeIndex = contextNodeIndex;
        if (!snapshot.isContextObject(node)) {
          break;
        }
        liveFunction.contextNodeIndexes.add(contextNodeIndex);
        contextNodeIndex = node.findInternalEdgeTarget('previous')?.nodeIndex;
      }
    }
    this.#liveFunctionsByScript = Map.groupBy(liveFunctions.values(), liveFunction => liveFunction.scriptId);
  }

  #resolveScopeInfoScriptId(scopeInfoNodeIndex: number): number|undefined {
    if (this.#scopeInfoScriptIds.has(scopeInfoNodeIndex)) {
      return this.#scopeInfoScriptIds.get(scopeInfoNodeIndex);
    }
    const visited: number[] = [];
    const seen = new Set<number>();
    const node = this.#node;
    let currentNodeIndex = scopeInfoNodeIndex;
    let scriptId: number|undefined;
    while (!seen.has(currentNodeIndex)) {
      if (this.#scopeInfoScriptIds.has(currentNodeIndex)) {
        scriptId = this.#scopeInfoScriptIds.get(currentNodeIndex);
        break;
      }
      seen.add(currentNodeIndex);
      visited.push(currentNodeIndex);
      node.nodeIndex = currentNodeIndex;
      const outerScopeInfo = node.findInternalEdgeTarget('outer_scope_info');
      if (!outerScopeInfo) {
        break;
      }
      currentNodeIndex = outerScopeInfo.nodeIndex;
    }
    for (const visitedNodeIndex of visited) {
      this.#scopeInfoScriptIds.set(visitedNodeIndex, scriptId);
    }
    return scriptId;
  }

  #correlateContextsWithScopes(): {
    scopes: Map<number, ScopeAccumulator>,
    unmatchedContexts: HeapSnapshotModel.HeapSnapshotModel.UnmatchedContext[],
  } {
    const unmatchedContexts: HeapSnapshotModel.HeapSnapshotModel.UnmatchedContext[] = [];
    const scopes = new Map<number, ScopeAccumulator>();
    const node = this.#node;

    for (const context of this.#contextNodes) {
      const contextInfo = {
        contextNodeIndex: context.contextNodeIndex,
        contextNodeId: context.contextNodeId,
      };
      if (context.scopeInfoNodeIndex === undefined) {
        unmatchedContexts.push({...contextInfo, reason: 'missing-scope-info'});
        continue;
      }
      node.nodeIndex = context.scopeInfoNodeIndex;
      const scopeInfoNodeId = node.id();
      const scopeStart = node.findInternalEdgeTarget('start_position')?.nodeValueAsInt();
      const scopeEnd = node.findInternalEdgeTarget('end_position')?.nodeValueAsInt();
      if (scopeStart === undefined || scopeEnd === undefined) {
        unmatchedContexts.push({...contextInfo, reason: 'missing-scope-position'});
        continue;
      }
      const scriptId = this.#resolveScopeInfoScriptId(context.scopeInfoNodeIndex);
      if (scriptId === undefined) {
        unmatchedContexts.push({...contextInfo, reason: 'missing-script'});
        continue;
      }
      const script = this.#scripts.get(scriptId);
      if (!script) {
        unmatchedContexts.push({...contextInfo, reason: 'missing-source'});
        continue;
      }
      if (script.sourceAnalysis.status === 'failed') {
        unmatchedContexts.push({...contextInfo, reason: script.sourceAnalysis.reason});
        continue;
      }
      const sourceScope = findSourceScope(script.sourceAnalysis.scopes, scopeStart, scopeEnd);
      if (!sourceScope) {
        unmatchedContexts.push({...contextInfo, reason: 'missing-source-scope'});
        continue;
      }

      let scope = scopes.get(context.scopeInfoNodeIndex);
      if (!scope) {
        scope = {
          scopeInfoNodeIndex: context.scopeInfoNodeIndex,
          scopeInfoNodeId,
          scriptId,
          scriptNodeId: script.nodeId,
          scriptName: script.name,
          sourceScope,
          fieldNames: [],
          contexts: [],
        };
        scopes.set(context.scopeInfoNodeIndex, scope);
      }
      const recordFieldNames = scope.contexts.length === 0;
      const fieldValueNodeIndexes: number[] = [];
      node.nodeIndex = context.contextNodeIndex;
      for (const edges = node.edges(); edges.hasNext(); edges.next()) {
        const edge = edges.item();
        if (edge.type() === 'context') {
          if (recordFieldNames) {
            scope.fieldNames.push(edge.name());
          }
          fieldValueNodeIndexes.push(edge.nodeIndex());
        }
      }

      scope.contexts.push({
        contextNodeIndex: context.contextNodeIndex,
        fieldValueNodeIndexes,
      });
    }

    return {scopes, unmatchedContexts};
  }

  #isVariableUsedInContext(scriptId: number, contextNodeIndex: number, variableUses: ContextVariableUse[]): boolean {
    for (const variableUse of variableUses) {
      const key = functionKey(scriptId, variableUse.functionStart, variableUse.functionEnd);
      let reachableContexts = this.#reachableContextsByFunction.get(key);
      if (!reachableContexts) {
        reachableContexts = new Set();
        this.#reachableContextsByFunction.set(key, reachableContexts);
        const liveFunctions = this.#liveFunctionsByScript.get(scriptId) ?? [];
        for (const liveFunction of liveFunctions) {
          // Check if this live function is the use site itself OR an enclosing function.
          // Executing a live outer closure can instantiate any function nested inside it,
          // so those inner functions can access the outer closure's context chain even
          // when no closure exists for them yet.
          //
          // Example:
          //   function outer() {
          //     const x = 1;
          //     return function middle() {       // <- liveFunction (on heap)
          //       return function inner() {      // <- variableUse site
          //         return x;
          //       };
          //     };
          //   }
          // No closure object exists on the heap for `inner` yet (so `inner` is not
          // in `liveFunctions`). However, executing `middle()` in the future will
          // instantiate `inner`, giving it access to `outer`'s Context containing `x`.
          if (liveFunction.functionStart <= variableUse.functionStart &&
              variableUse.functionEnd <= liveFunction.functionEnd) {
            for (const reachableContextNodeIndex of liveFunction.contextNodeIndexes) {
              reachableContexts.add(reachableContextNodeIndex);
            }
          }
        }
      }
      if (reachableContexts.has(contextNodeIndex)) {
        return true;
      }
    }
    return false;
  }

  #classifyFields(scopes: Map<number, ScopeAccumulator>): HeapSnapshotModel.HeapSnapshotModel.ScopeAnalysis[] {
    const scopeAnalyses: HeapSnapshotModel.HeapSnapshotModel.ScopeAnalysis[] = [];
    const node = this.#node;

    for (const scope of scopes.values()) {
      const variableUsesByField = scope.fieldNames.map(name => scope.sourceScope.variables.get(name));
      const scopeContexts: HeapSnapshotModel.HeapSnapshotModel.ContextAnalysis[] = [];
      for (const context of scope.contexts) {
        let contextDeadFieldsRetainedSizeSum = 0;
        const deadFields: HeapSnapshotModel.HeapSnapshotModel.ContextField[] = [];
        for (let fieldIndex = 0; fieldIndex < context.fieldValueNodeIndexes.length; ++fieldIndex) {
          const fieldValueNodeIndex = context.fieldValueNodeIndexes[fieldIndex];
          const variableUses = variableUsesByField[fieldIndex];
          if (variableUses === undefined ||
              this.#isVariableUsedInContext(scope.scriptId, context.contextNodeIndex, variableUses)) {
            // Only report dead fields.
            continue;
          }
          node.nodeIndex = fieldValueNodeIndex;
          const retainedSize = node.retainedSize();
          deadFields.push({
            name: scope.fieldNames[fieldIndex],
            valueNodeIndex: fieldValueNodeIndex,
            valueNodeId: node.id(),
            valueName: node.name(),
            valueType: node.type(),
            selfSize: node.selfSize(),
            retainedSize,
          });
          contextDeadFieldsRetainedSizeSum += retainedSize;
        }
        if (deadFields.length === 0) {
          continue;
        }
        node.nodeIndex = context.contextNodeIndex;
        const contextAnalysis = {
          contextNodeIndex: context.contextNodeIndex,
          contextNodeId: node.id(),
          retainedSize: node.retainedSize(),
          deadFieldsRetainedSizeSum: contextDeadFieldsRetainedSizeSum,
          deadFields,
        };
        scopeContexts.push(contextAnalysis);
      }
      if (scopeContexts.length === 0) {
        continue;
      }
      scopeAnalyses.push({
        scopeInfoNodeIndex: scope.scopeInfoNodeIndex,
        scopeInfoNodeId: scope.scopeInfoNodeId,
        scriptId: scope.scriptId,
        scriptNodeId: scope.scriptNodeId,
        scriptName: scope.scriptName,
        scopeName: scope.sourceScope.name,
        scopeStart: scope.sourceScope.start,
        scopeEnd: scope.sourceScope.end,
        contextFieldCount: scope.fieldNames.length,
        contexts: scopeContexts,
      });
    }

    return scopeAnalyses;
  }

  #sortAndBuildResult(scopeAnalyses: HeapSnapshotModel.HeapSnapshotModel.ScopeAnalysis[],
                      unmatchedContexts: HeapSnapshotModel.HeapSnapshotModel.UnmatchedContext[]):
      HeapSnapshotModel.HeapSnapshotModel.ContextAnalysisResult {
    const compareContexts = (left: HeapSnapshotModel.HeapSnapshotModel.ContextAnalysis,
                             right: HeapSnapshotModel.HeapSnapshotModel.ContextAnalysis): number => {
      return right.deadFieldsRetainedSizeSum - left.deadFieldsRetainedSizeSum ||
          right.retainedSize - left.retainedSize || left.contextNodeIndex - right.contextNodeIndex;
    };
    for (const scope of scopeAnalyses) {
      for (const context of scope.contexts) {
        context.deadFields.sort((left, right) => right.retainedSize - left.retainedSize);
      }
      scope.contexts.sort(compareContexts);
    }
    scopeAnalyses.sort((left, right) => compareContexts(left.contexts[0], right.contexts[0]));
    unmatchedContexts.sort((left, right) => left.contextNodeIndex - right.contextNodeIndex);
    return {scopes: scopeAnalyses, unmatchedContexts};
  }
}
