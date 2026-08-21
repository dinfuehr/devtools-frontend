// Copyright 2022 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';

import * as FormatterWorker from './formatter_worker.js';
import * as FormatterAction from './FormatterActions.js';  // eslint-disable-line @devtools/es-modules-import

describe('ScopeParser', () => {
  describe('parseScopes', () => {
    const {parseScopes} = FormatterWorker.ScopeParser;

    it('parses simple function', () => {
      const scopes = parseScopes('function foo(a){}');

      const innerScope = scopes?.children[0];
      assert.strictEqual(innerScope?.start, 12);
      assert.strictEqual(innerScope?.end, 17);
      assert.strictEqual(innerScope?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(innerScope?.name, 'foo');
      assert.deepEqual(innerScope?.nameMappingLocations, [9, 12]);
      assert.deepEqual(innerScope?.variables?.get('a')?.uses.map(u => u.offset), [13]);
    });

    it('parses function expression', () => {
      const scopes = parseScopes('const foo = function(a) {}; const bar = function b() {}');

      const scopeFoo = scopes?.children[0];
      assert.strictEqual(scopeFoo?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.isUndefined(scopeFoo?.name);
      assert.deepEqual(scopeFoo?.nameMappingLocations, [20]);

      const scopeBar = scopes?.children[1];
      assert.strictEqual(scopeBar?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeBar?.name, 'b');
      assert.deepEqual(scopeBar?.nameMappingLocations, [49, 50]);
    });

    it('parses arrow function', () => {
      const scopes = parseScopes('let f = (a) => {}');

      assert.strictEqual(scopes?.children.length, 1);
      const innerScope = scopes?.children[0];
      assert.strictEqual(innerScope?.start, 8);
      assert.strictEqual(innerScope?.end, 17);
      assert.strictEqual(innerScope?.kind, FormatterAction.ScopeKind.ARROW_FUNCTION);
      assert.deepEqual(innerScope?.variables?.size, 1);
      assert.deepEqual(innerScope?.variables?.get('a')?.uses.map(u => u.offset), [9]);
      assert.deepEqual(innerScope?.nameMappingLocations, [8, 12]);
    });

    it('parses for loop', () => {
      const scopes = parseScopes('for (let i = 0; i < 3; i++) console.log(i);');

      const innerScope = scopes?.children[0];
      assert.strictEqual(innerScope?.start, 0);
      assert.strictEqual(innerScope?.end, 43);
      assert.deepEqual(innerScope?.variables?.size, 1);
      assert.deepEqual(innerScope?.variables?.get('i')?.uses.map(u => u.offset), [9, 16, 23, 40]);
    });

    it('parses block scope', () => {
      const scopes = parseScopes('let x; { let y; }');

      assert.strictEqual(scopes?.start, 0);
      assert.strictEqual(scopes?.end, 17);
      assert.deepEqual(scopes?.variables?.size, 1);
      assert.deepEqual(scopes?.variables?.get('x')?.uses.map(u => u.offset), [4]);
      const blockScope = scopes?.children[0];
      assert.strictEqual(blockScope?.start, 7);
      assert.strictEqual(blockScope?.end, 17);
      assert.deepEqual(blockScope?.variables?.size, 1);
      assert.deepEqual(blockScope?.variables?.get('y')?.uses.map(u => u.offset), [13]);
    });

    it('parses object destructuring', () => {
      const source = 'let {x: y} = {}';
      const scopes = parseScopes(source);

      assert.exists(scopes);
      assert.isEmpty(scopes.children);
      assert.strictEqual(scopes.variables.size, 1);
      const [[name, {uses}]] = scopes.variables;
      assert.strictEqual(name, 'y');
      assert.lengthOf(uses, 1);
      assert.strictEqual(uses[0].offset, source.indexOf('y'));
    });

    it('parses object destructuring with default values', () => {
      const source = 'let {x: y = 42} = {}';
      const scopes = parseScopes(source);

      assert.exists(scopes);
      assert.isEmpty(scopes.children);
      assert.strictEqual(scopes.variables.size, 1);
      const [[name, {uses}]] = scopes.variables;
      assert.strictEqual(name, 'y');
      assert.lengthOf(uses, 1);
      assert.strictEqual(uses[0].offset, source.indexOf('y'));
    });

    it('parses object destructuring with short-hand syntax', () => {
      const source = 'let {x} = {}';
      const scopes = parseScopes(source);

      assert.exists(scopes);
      assert.isEmpty(scopes.children);
      assert.strictEqual(scopes.variables.size, 1);
      const [[name, {uses}]] = scopes.variables;
      assert.strictEqual(name, 'x');
      assert.lengthOf(uses, 1);
      assert.strictEqual(uses[0].offset, source.indexOf('x'));
    });

    it('parses object destructuring with short-hand syntax and default values', () => {
      const source = 'let {x = 42} = {}';
      const scopes = parseScopes(source);

      assert.exists(scopes);
      assert.isEmpty(scopes.children);
      assert.strictEqual(scopes.variables.size, 1);
      const [[name, {uses}]] = scopes.variables;
      assert.strictEqual(name, 'x');
      assert.lengthOf(uses, 1);
      assert.strictEqual(uses[0].offset, source.indexOf('x'));
    });

    it('parses ES modules', () => {
      const source = 'import * as Foo from "./foo.js"; Foo.foo();';
      const scopes = parseScopes(source, 'module');

      assert.exists(scopes);
      assert.isEmpty(scopes.children);
      assert.strictEqual(scopes.variables.size, 1);
      const [[name, {uses}]] = scopes.variables;
      assert.strictEqual(name, 'Foo');
      assert.lengthOf(uses, 1);
      const firstOccurence = source.indexOf('Foo');
      assert.strictEqual(uses[0].offset, source.indexOf('Foo', firstOccurence + 1));
    });

    it('parses methods', () => {
      const scopes = parseScopes(`class C { someMethod() {} }`);

      const scopeMethod = scopes?.children[0];
      assert.strictEqual(scopeMethod?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeMethod?.name, 'someMethod');
      assert.deepEqual(scopeMethod?.nameMappingLocations, [10, 20]);
    });

    it('parses private methods', () => {
      const scopes = parseScopes(`class C { #someMethod() {} }`);

      const scopeMethod = scopes?.children[0];
      assert.strictEqual(scopeMethod?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeMethod?.name, '#someMethod');
      assert.deepEqual(scopeMethod?.nameMappingLocations, [10, 21]);
    });

    it('parses getters and setters', () => {
      const scopes = parseScopes(`class C { get foo() {} set foo(value) {} }`);

      const scopeGet = scopes?.children[0];
      assert.strictEqual(scopeGet?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeGet?.name, 'foo');
      assert.deepEqual(scopeGet?.nameMappingLocations, [14, 17]);

      const scopeSet = scopes?.children[1];
      assert.strictEqual(scopeSet?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeGet?.name, 'foo');
      assert.deepEqual(scopeSet?.nameMappingLocations, [27, 30]);
    });

    it('parses method syntax in object literals', () => {
      const scopes = parseScopes('const obj = { someMethod() {} };');

      const scopeMethod = scopes?.children[0];
      assert.strictEqual(scopeMethod?.kind, FormatterAction.ScopeKind.FUNCTION);
      assert.strictEqual(scopeMethod?.name, 'someMethod');
      assert.deepEqual(scopeMethod?.nameMappingLocations, [14, 24]);
    });

    it('parses async arrow functions', () => {
      const scopes = parseScopes('const x = async y => await y;');

      const scopeFn = scopes?.children[0];
      assert.strictEqual(scopeFn?.kind, FormatterAction.ScopeKind.ARROW_FUNCTION);
      assert.deepEqual(scopeFn?.nameMappingLocations, [18]);
    });

    it('doesn\'t get confused by default values in arrow functions', () => {
      const scopes = parseScopes('const x = (a = 42) => console.log(a);');

      const scopeFn = scopes?.children[0];
      assert.strictEqual(scopeFn?.kind, FormatterAction.ScopeKind.ARROW_FUNCTION);
      assert.deepEqual(scopeFn?.nameMappingLocations, [10, 19]);
    });

    it('reports the function that closes over a variable', () => {
      const source = `
        function outer() {
          let captured = 1;
          let stackOnly = 2;
          return function inner() {
            return captured;
          };
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const inner = outer.children[0];
      const captured = outer.variables.find(variable => variable.name === 'captured');
      const stackOnly = outer.variables.find(variable => variable.name === 'stackOnly');
      assert.exists(captured);
      assert.exists(stackOnly);
      assert.deepEqual(captured.offsets, [source.indexOf('captured'), source.lastIndexOf('captured')]);
      assert.deepEqual(captured.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('captured')],
                       }]);
      assert.isEmpty(stackOnly.contextUses);
    });

    it('groups context uses by the function containing each use', () => {
      const source = `
        function outer() {
          let captured = 1;
          function first() {
            return captured + captured;
          }
          const second = () => captured;
          return [first, second];
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const first = outer.children.find(scope => scope.name === 'first');
      const second = outer.children.find(scope => scope.kind === FormatterAction.ScopeKind.ARROW_FUNCTION);
      const captured = outer.variables.find(variable => variable.name === 'captured');
      assert.exists(first);
      assert.exists(second);
      assert.exists(captured);
      const definition = source.indexOf('captured');
      const firstUse = source.indexOf('captured', definition + 1);
      const secondUse = source.indexOf('captured', firstUse + 1);
      const thirdUse = source.lastIndexOf('captured');
      assert.deepEqual(captured.offsets, [definition, firstUse, secondUse, thirdUse]);
      assert.deepEqual(captured.contextUses, [
        {
          functionStart: first.start,
          functionEnd: first.end,
          offsets: [firstUse, secondUse],
        },
        {
          functionStart: second.start,
          functionEnd: second.end,
          offsets: [thirdUse],
        },
      ]);
    });

    it('does not report context uses for free variables', () => {
      const source = `
        function outer() {
          return () => missing + missing;
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const missing = scopeTree.variables.find(variable => variable.name === 'missing');
      assert.exists(missing);
      assert.strictEqual(missing.kind, FormatterAction.DefinitionKind.NONE);
      assert.deepEqual(missing.offsets, [source.indexOf('missing'), source.lastIndexOf('missing')]);
      assert.isEmpty(missing.contextUses);
    });

    for (const [declarationKind, definitionKind] of [['var', FormatterAction.DefinitionKind.VAR],
                                                     ['let', FormatterAction.DefinitionKind.LET],
                                                     ['const', FormatterAction.DefinitionKind.LET],
    ] as const) {
      it(`reports closure uses of global ${declarationKind} variables`, () => {
        const source = `
          ${declarationKind} captured = 1;
          captured;
          function inner() {
            return captured;
          }
        `;
        const scopeTree = parseScopes(source)?.export();

        assert.exists(scopeTree);
        assert.strictEqual(scopeTree.kind, FormatterAction.ScopeKind.GLOBAL);
        const inner = scopeTree.children.find(scope => scope.name === 'inner');
        const captured = scopeTree.variables.find(variable => variable.name === 'captured');
        assert.exists(inner);
        assert.strictEqual(inner.kind, FormatterAction.ScopeKind.FUNCTION);
        assert.exists(captured);
        const definition = source.indexOf('captured');
        const globalUse = source.indexOf('captured', definition + 1);
        const closureUse = source.lastIndexOf('captured');
        assert.strictEqual(captured.kind, definitionKind);
        assert.deepEqual(captured.offsets, [definition, globalUse, closureUse]);
        assert.deepEqual(captured.contextUses, [{
                           functionStart: inner.start,
                           functionEnd: inner.end,
                           offsets: [closureUse],
                         }]);
      });
    }

    it('reports captures from for-of body scopes', () => {
      const source = `
        function makeClosures() {
          const closures = [];
          for (const item of [1, 2]) {
            const captured = {item};
            const unused = 42;
            closures.push(function blockInner() {
              return captured;
            });
          }
          return closures;
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const loop = outer.children.find(scope => scope.variables.some(variable => variable.name === 'item'));
      const body = loop?.children.find(scope => scope.variables.some(variable => variable.name === 'captured'));
      const inner = body?.children.find(scope => scope.kind === FormatterAction.ScopeKind.FUNCTION);
      const item = loop?.variables.find(variable => variable.name === 'item');
      const captured = body?.variables.find(variable => variable.name === 'captured');
      const unused = body?.variables.find(variable => variable.name === 'unused');
      assert.exists(inner);
      assert.exists(item);
      assert.exists(captured);
      assert.exists(unused);
      assert.deepEqual(item.offsets, [source.indexOf('item'), source.lastIndexOf('item')]);
      assert.deepEqual(captured.offsets, [source.indexOf('captured'), source.lastIndexOf('captured')]);
      assert.deepEqual(unused.offsets, [source.indexOf('unused')]);
      assert.isEmpty(item.contextUses);
      assert.deepEqual(captured.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('captured')],
                       }]);
      assert.isEmpty(unused.contextUses);
    });

    it('reports captures of for-of iteration variables', () => {
      const source = `
        function makeClosures(values) {
          const closures = [];
          for (const item of values) {
            closures.push(() => item);
          }
          return closures;
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const loop = outer.children.find(scope => scope.variables.some(variable => variable.name === 'item'));
      const body = loop?.children[0];
      const inner = body?.children.find(scope => scope.kind === FormatterAction.ScopeKind.ARROW_FUNCTION);
      const item = loop?.variables.find(variable => variable.name === 'item');
      assert.exists(inner);
      assert.exists(item);
      assert.deepEqual(item.offsets, [source.indexOf('item'), source.lastIndexOf('item')]);
      assert.deepEqual(item.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('item')],
                       }]);
    });

    it('reports captures of classic for-loop variables', () => {
      const source = `
        function makeCallbacks() {
          const callbacks = [];
          for (let index = 0; index < 2; ++index) {
            callbacks.push(() => index);
          }
          return callbacks;
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const loop = outer.children.find(scope => scope.variables.some(variable => variable.name === 'index'));
      const body = loop?.children[0];
      const inner = body?.children.find(scope => scope.kind === FormatterAction.ScopeKind.ARROW_FUNCTION);
      const index = loop?.variables.find(variable => variable.name === 'index');
      assert.exists(inner);
      assert.exists(index);
      const firstIndex = source.indexOf('index');
      const secondIndex = source.indexOf('index', firstIndex + 1);
      const thirdIndex = source.indexOf('index', secondIndex + 1);
      assert.deepEqual(index.offsets, [firstIndex, secondIndex, thirdIndex, source.lastIndexOf('index')]);
      assert.deepEqual(index.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('index')],
                       }]);
    });

    it('reports captures of catch parameters and catch-body variables', () => {
      const source = `
        function makeHandler() {
          try {
            throw new Error('boom');
          } catch (error) {
            const detail = error.message;
            const unused = 42;
            return () => [error, detail];
          }
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const makeHandlerScope = scopeTree.children[0];
      const catchScope =
          makeHandlerScope.children.find(scope => scope.variables.some(variable => variable.name === 'error'));
      assert.strictEqual(catchScope?.kind, FormatterAction.ScopeKind.BLOCK);
      const catchBlock =
          catchScope?.children.find(scope => scope.variables.some(variable => variable.name === 'detail'));
      assert.strictEqual(catchBlock?.kind, FormatterAction.ScopeKind.BLOCK);
      const inner = catchBlock?.children.find(scope => scope.kind === FormatterAction.ScopeKind.ARROW_FUNCTION);
      const error = catchScope?.variables.find(variable => variable.name === 'error');
      const detail = catchBlock?.variables.find(variable => variable.name === 'detail');
      const unused = catchBlock?.variables.find(variable => variable.name === 'unused');
      assert.exists(inner);
      assert.exists(error);
      assert.exists(detail);
      assert.exists(unused);
      assert.deepEqual(error.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('error')],
                       }]);
      assert.deepEqual(detail.contextUses, [{
                         functionStart: inner.start,
                         functionEnd: inner.end,
                         offsets: [source.lastIndexOf('detail')],
                       }]);
      assert.isEmpty(unused.contextUses);
    });

    it('attributes nested context uses to the function containing each use', () => {
      const source = `
        function outer() {
          let outerCaptured = 1;
          return function inner() {
            let innerCaptured = 2;
            return function nested_inner() {
              return outerCaptured + innerCaptured;
            };
          };
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const inner = outer.children[0];
      const nestedInner = inner.children[0];
      const outerCaptured = outer.variables.find(variable => variable.name === 'outerCaptured');
      const innerCaptured = inner.variables.find(variable => variable.name === 'innerCaptured');
      assert.exists(outerCaptured);
      assert.exists(innerCaptured);
      assert.deepEqual(outerCaptured.contextUses, [{
                         functionStart: nestedInner.start,
                         functionEnd: nestedInner.end,
                         offsets: [source.lastIndexOf('outerCaptured')],
                       }]);
      assert.deepEqual(innerCaptured.contextUses, [{
                         functionStart: nestedInner.start,
                         functionEnd: nestedInner.end,
                         offsets: [source.lastIndexOf('innerCaptured')],
                       }]);
    });

    it('does not report same-function block uses or shadowed variables as context uses', () => {
      const source = `
        function outer() {
          let value = 1;
          { value++; }
          return function inner(value) {
            return value;
          };
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const inner = outer.children.find(scope => scope.kind === FormatterAction.ScopeKind.FUNCTION);
      const outerValue = outer.variables.find(variable => variable.name === 'value');
      const innerValue = inner?.variables.find(variable => variable.name === 'value');
      assert.exists(outerValue);
      assert.exists(innerValue);
      const outerDefinition = source.indexOf('value');
      const outerUse = source.indexOf('value', outerDefinition + 1);
      const innerDefinition = source.indexOf('value', outerUse + 1);
      assert.deepEqual(outerValue.offsets, [outerDefinition, outerUse]);
      assert.deepEqual(innerValue.offsets, [innerDefinition, source.lastIndexOf('value')]);
      assert.isEmpty(outerValue.contextUses);
      assert.isEmpty(innerValue.contextUses);
    });

    it('attributes captures to shadowing bindings', () => {
      const source = `
        function outer() {
          let value = 1;
          return function inner(value) {
            return () => value;
          };
        }
      `;
      const scopeTree = parseScopes(source)?.export();

      assert.exists(scopeTree);
      const outer = scopeTree.children[0];
      const inner = outer.children.find(scope => scope.name === 'inner');
      const nested = inner?.children.find(scope => scope.kind === FormatterAction.ScopeKind.ARROW_FUNCTION);
      const outerValue = outer.variables.find(variable => variable.name === 'value');
      const innerValue = inner?.variables.find(variable => variable.name === 'value');
      assert.exists(nested);
      assert.exists(outerValue);
      assert.exists(innerValue);
      const outerDefinition = source.indexOf('value');
      const innerDefinition = source.indexOf('value', outerDefinition + 1);
      const innerUse = source.lastIndexOf('value');
      assert.deepEqual(outerValue.offsets, [outerDefinition]);
      assert.isEmpty(outerValue.contextUses);
      assert.deepEqual(innerValue.offsets, [innerDefinition, innerUse]);
      assert.deepEqual(innerValue.contextUses, [{
                         functionStart: nested.start,
                         functionEnd: nested.end,
                         offsets: [innerUse],
                       }]);
    });
  });
});
