// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function makeParameterClosure(parameterCaptured = {
  kind: 'parameter'
}) {
  const bodyCaptured = {kind: 'body'};
  const bodyDead = {data: new Array(128).fill(0)};
  (function discardedBodyDeadReader() {
    return bodyDead;
  })();
  return function parameterReader() {
    return [parameterCaptured, bodyCaptured];
  };
}

globalThis.parameterClosure = makeParameterClosure();
