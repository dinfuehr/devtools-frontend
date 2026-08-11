// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Run from this directory with:
// <v8>/out/x64.release/d8 --allow-natives-syntax --module _main.js
import './module.js';

load('async.js');
load('block.js');
load('block-variable.js');
load('block-variable-inner.js');
load('catch-parameter.js');
load('catch.js');
load('class-direct.js');
load('class-initializer-context.js');
load('class-methods.js');
load('class.js');
load('context.js');
load('dead-closure.js');
load('direct-eval.js');
load('for-of.js');
load('generator.js');
load('nested.js');
load('parameter.js');
load('shadowed.js');
load('uninstantiated-inner.js');

% TakeHeapSnapshot('../context-analysis.heapsnapshot');
