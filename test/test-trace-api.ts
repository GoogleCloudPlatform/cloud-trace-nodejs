/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import './override-gcp-metadata';
import { cls, TraceCLSMechanism } from '../src/cls';
import { defaultConfig } from '../src/config';
import { TraceAgent } from '../src/trace-api';
import { traceWriter } from '../src/trace-writer';
import * as TracingPolicy from '../src/tracing-policy';
import { FORCE_NEW } from '../src/util';
import { asRootSpanData, asChildSpanData } from './utils';
import { SpanType } from '../src/constants';

var assert = require('assert');
var common = require('./plugins/common'/*.js*/);
var EventEmitter = require('events');
var nock = require('nock');
var request = require('request');

var logger = require('@google-cloud/common').logger();

nock.disableNetConnect();

function createTraceAgent(policy?, config?) {
  var result = new TraceAgent('test');
  result.enable(config || {
    enhancedDatabaseReporting: false,
    ignoreContextHeader: false
  }, logger);
  result.policy = policy || new TracingPolicy.TraceAllPolicy();
  return result;
}

function assertAPISurface(traceAPI) {
  assert.strictEqual(typeof traceAPI.enhancedDatabaseReportingEnabled(), 'boolean');
  traceAPI.runInRootSpan({ name: 'root' }, function(root) {
    assert.strictEqual(typeof root.addLabel, 'function');
    assert.strictEqual(typeof root.endSpan, 'function');
    assert.strictEqual(typeof root.getTraceContext(), 'string');
    var child = traceAPI.createChildSpan({ name: 'child' });
    assert.strictEqual(typeof child.addLabel, 'function');
    assert.strictEqual(typeof child.endSpan, 'function');
    assert.strictEqual(typeof child.getTraceContext(), 'string');
  });
  assert.strictEqual(typeof traceAPI.getCurrentContextId, 'function');
  assert.strictEqual(typeof traceAPI.getWriterProjectId, 'function');
  assert.strictEqual(typeof traceAPI.wrap(function() {}), 'function');
  assert.strictEqual(typeof traceAPI.wrapEmitter(new EventEmitter()), 'undefined');
  assert.strictEqual(typeof traceAPI.constants, 'object');
  assert.strictEqual(typeof traceAPI.labels, 'object');
}

describe('Trace Interface', function() {
  before(function(done) {
    cls.create({ mechanism: TraceCLSMechanism.ASYNC_LISTENER }, logger).enable();
    traceWriter.create(
      Object.assign(defaultConfig, {
        projectId: '0',
        [FORCE_NEW]: false
      }), logger).initialize(function(err) {
        assert.ok(!err);
        done();
      });
  });

  it('should correctly manage internal state', function() {
    var traceAPI = createTraceAgent();
    assert.ok(traceAPI.isActive(),
      'Newly created instances are active');
    traceAPI.disable();
    assert.ok(!traceAPI.isActive(),
      'Being disabled sets isActive to false');
  });

  it('should expose the same interface regardless of state', function() {
    var traceAPI = createTraceAgent();
    assertAPISurface(traceAPI);
    traceAPI.disable();
    assertAPISurface(traceAPI);
  });

  describe('constants', function() {
    it('have correct values', function() {
      var traceAPI = createTraceAgent();
      assert.equal(traceAPI.constants.TRACE_CONTEXT_HEADER_NAME,
        'x-cloud-trace-context');
      assert.equal(traceAPI.constants.TRACE_AGENT_REQUEST_HEADER,
        'x-cloud-trace-agent-request');
    });
  });

  describe('behavior when initialized', function() {
    before(function() {
      traceWriter.get().request = request;
      common.avoidTraceWriterAuth();
    });

    afterEach(function() {
      common.cleanTraces();
    });

    it('should produce real child spans with createChildSpan', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root'}, function(root_) {
        var root = asRootSpanData(root_);
        var child = asChildSpanData(traceAPI.createChildSpan({name: 'sub'}));
        assert.strictEqual(child.span.parentSpanId, root.span.spanId);
        child.addLabel('key', 'val');
        child.endSpan();
        root.endSpan();
        var spanPredicate = function(span) {
          return span.name === 'sub';
        };
        var matchingSpan = common.getMatchingSpan(spanPredicate);
        assert.equal(matchingSpan.labels.key, 'val');
      });
    });

    it('should produce real child spans with thru root span API', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root'}, function(root_) {
        var root = asRootSpanData(root_);
        var child = asChildSpanData(root.createChildSpan({name: 'sub'}));
        child.endSpan();
        root.endSpan();
        assert.strictEqual(child.span.parentSpanId, root.span.spanId);
        var spanPredicate = function(span) {
          return span.name === 'sub';
        };
        common.getMatchingSpan(spanPredicate); // use assertion in gMS

      });
    });

    it('should produce real root spans runInRootSpan', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(rootSpan_) {
        var rootSpan = asRootSpanData(rootSpan_);
        rootSpan.addLabel('key', 'val');
        var childSpan = asChildSpanData(traceAPI.createChildSpan({name: 'sub'}));
        childSpan.endSpan();
        rootSpan.endSpan();
        var spanPredicate = function(span) {
          return span.name === 'root';
        };
        var matchingSpan = common.getMatchingSpan(spanPredicate);
        assert.equal(matchingSpan.labels.key, 'val');
      });
    });

    it('should allow sequential root spans', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(rootSpan1_) {
        var rootSpan1 = asRootSpanData(rootSpan1_);
        rootSpan1.endSpan();
      });
      traceAPI.runInRootSpan({name: 'root2', url: 'root2'}, function(rootSpan2) {
        rootSpan2.endSpan();
        var spans = common.getMatchingSpans(function() { return true; });
        assert.equal(spans.length, 2);
        assert.ok(spans.find(span => span.name === 'root'));
        assert.ok(spans.find(span => span.name === 'root2'));
      });
    });

    it('should not allow nested root spans', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(rootSpan1_) {
        var rootSpan1 = asRootSpanData(rootSpan1_);
        traceAPI.runInRootSpan({name: 'root2', url: 'root2'}, function(rootSpan2) {
          assert.strictEqual(rootSpan2.type, SpanType.UNCORRELATED);
          const childSpan = rootSpan2.createChildSpan({ name: 'child' });
          assert.strictEqual(childSpan.type, SpanType.UNCORRELATED);
        });
        rootSpan1.endSpan();
        var span = common.getMatchingSpan(function() { return true; });
        assert.equal(span.name, 'root');
      });
    });

    it('should return null context id when one does not exist', function() {
      var traceAPI = createTraceAgent();
      assert.strictEqual(traceAPI.getCurrentContextId(), null);
    });

    it('should return the appropriate trace id', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(rootSpan_) {
        var rootSpan = asRootSpanData(rootSpan_);
        var id = traceAPI.getCurrentContextId();
        assert.strictEqual(id, rootSpan.trace.traceId);
      });
    });

    it('should return get the project ID if set in config', function() {
      var config = {projectId: 'project-1'};
      var traceApi = createTraceAgent(null /* policy */, config);
      assert.equal(traceApi.getWriterProjectId(), 'project-1');
    });

    it('should add labels to spans', function() {
      var traceAPI = createTraceAgent();
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(root_) {
        var root = asRootSpanData(root_);
        var child = asChildSpanData(traceAPI.createChildSpan({name: 'sub'}));
        child.addLabel('test1', 'value');
        child.endSpan();
        assert.equal(child.span.name, 'sub');
        assert.ok(child.span.labels);
        assert.equal(child.span.labels.test1, 'value');
        root.endSpan();
      });
    });

    it('should respect trace policy', function(done) {
      var traceAPI = createTraceAgent(new TracingPolicy.TraceNonePolicy());
      traceAPI.runInRootSpan({name: 'root', url: 'root'}, function(rootSpan) {
        assert.strictEqual(rootSpan.type, SpanType.UNTRACED);
        const childSpan = rootSpan.createChildSpan({ name: 'child' });
        assert.strictEqual(childSpan.type, SpanType.UNTRACED);
        done();
      });
    });

    it('should respect filter urls', function() {
      var url = 'rootUrl';
      var traceAPI = createTraceAgent(new TracingPolicy.FilterPolicy(
        new TracingPolicy.TraceAllPolicy(),
        [url]));
      traceAPI.runInRootSpan({name: 'root1', url: url}, function(rootSpan) {
        assert.strictEqual(rootSpan.type, SpanType.UNTRACED);
      });
      traceAPI.runInRootSpan({name: 'root2', url: 'alternativeUrl'}, function(rootSpan_) {
        var rootSpan = asRootSpanData(rootSpan_);
        assert.strictEqual(rootSpan.span.name, 'root2');
      });
    });

    it('should respect enhancedDatabaseReporting options field', function() {
      [true, false].forEach(function(enhancedDatabaseReporting) {
        var traceAPI = createTraceAgent(null, {
          enhancedDatabaseReporting: enhancedDatabaseReporting,
          ignoreContextHeader: false
        });
        assert.strictEqual(traceAPI.enhancedDatabaseReportingEnabled(),
          enhancedDatabaseReporting);
      });
    });

    it('should respect ignoreContextHeader options field', function() {
      var traceAPI;
      // ignoreContextHeader: true
      traceAPI = createTraceAgent(null, {
        enhancedDatabaseReporting: false,
        ignoreContextHeader: true
      });
      traceAPI.runInRootSpan({
        name: 'root',
        traceContext: '123456/667;o=1'
      }, function(rootSpan) {
        assert.ok(rootSpan);
        assert.strictEqual(rootSpan.span.name, 'root');
        assert.notEqual(rootSpan.trace.traceId, '123456');
        assert.notEqual(rootSpan.span.parentSpanId, '667');
      });
      // ignoreContextHeader: false
      traceAPI = createTraceAgent(null, {
        enhancedDatabaseReporting: false,
        ignoreContextHeader: false
      });
      traceAPI.runInRootSpan({
        name: 'root',
        traceContext: '123456/667;o=1'
      }, function(rootSpan) {
        assert.ok(rootSpan);
        assert.strictEqual(rootSpan.span.name, 'root');
        assert.strictEqual(rootSpan.trace.traceId, '123456');
        assert.strictEqual(rootSpan.span.parentSpanId, '667');
      });
    });

    describe('getting response trace context', () => {
      it('should behave as expected', () => {
        const fakeTraceId = 'ffeeddccbbaa99887766554433221100';
        const traceApi = createTraceAgent();
        const tracedContext = fakeTraceId + '/0;o=1';
        const untracedContext = fakeTraceId + '/0;o=0';
        const unspecifiedContext = fakeTraceId + '/0';
        assert.strictEqual(
            traceApi.getResponseTraceContext(tracedContext, true),
            tracedContext);
        assert.strictEqual(
            traceApi.getResponseTraceContext(tracedContext, false),
            untracedContext);
        assert.strictEqual(
            traceApi.getResponseTraceContext(untracedContext, true),
            untracedContext);
        assert.strictEqual(
            traceApi.getResponseTraceContext(untracedContext, false),
            untracedContext);
        assert.strictEqual(
            traceApi.getResponseTraceContext(unspecifiedContext, true),
            untracedContext);
        assert.strictEqual(
            traceApi.getResponseTraceContext(unspecifiedContext, false),
            untracedContext);
      });
    });
  });
});

export default {};
