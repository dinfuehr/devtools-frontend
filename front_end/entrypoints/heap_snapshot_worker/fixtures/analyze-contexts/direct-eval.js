// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function makeDirectEvalClosure() {
  const dynamicallyRead = {kind: 'dynamic'};
  const maybeDead = {data: new Array(128).fill(0)};
  eval('');
  return function directEvalReader(name) {
    return eval(name);
  };
}

globalThis.directEvalClosure = makeDirectEvalClosure();
globalThis.directEvalResult = globalThis.directEvalClosure('dynamicallyRead');
