window.__ModuleLoader__.load({
  id: "@copis-ext/creation-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// ../../node_modules/jotai/vanilla/internals.js
var require_internals = __commonJS((exports2) => {
  function _arrayLikeToArray(r, a) {
    (a == null || a > r.length) && (a = r.length);
    for (var e = 0, n = Array(a);e < a; e++)
      n[e] = r[e];
    return n;
  }
  function _createForOfIteratorHelperLoose(r, e) {
    var t = typeof Symbol != "undefined" && r[Symbol.iterator] || r["@@iterator"];
    if (t)
      return (t = t.call(r)).next.bind(t);
    if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e) {
      t && (r = t);
      var o = 0;
      return function() {
        return o >= r.length ? {
          done: true
        } : {
          done: false,
          value: r[o++]
        };
      };
    }
    throw new TypeError(`Invalid attempt to iterate non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
  }
  function _unsupportedIterableToArray(r, a) {
    if (r) {
      if (typeof r == "string")
        return _arrayLikeToArray(r, a);
      var t = {}.toString.call(r).slice(8, -1);
      return t === "Object" && r.constructor && (t = r.constructor.name), t === "Map" || t === "Set" ? Array.from(r) : t === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : undefined;
    }
  }
  function hasInitialValue(atom) {
    return "init" in atom;
  }
  function isActuallyWritableAtom(atom) {
    return !!atom.write;
  }
  function isAtomStateInitialized(atomState) {
    return "v" in atomState || "e" in atomState;
  }
  function returnAtomValue(atomState) {
    if ("e" in atomState) {
      throw atomState.e;
    }
    if (false) {}
    return atomState.v;
  }
  var promiseStateMap = new WeakMap;
  function isPendingPromise(value) {
    var _promiseStateMap$get;
    return isPromiseLike(value) && !!((_promiseStateMap$get = promiseStateMap.get(value)) != null && _promiseStateMap$get[0]);
  }
  function abortPromise(promise) {
    var promiseState = promiseStateMap.get(promise);
    if (promiseState != null && promiseState[0]) {
      promiseState[0] = false;
      promiseState[1].forEach(function(fn) {
        return fn();
      });
    }
  }
  function registerAbortHandler(promise, abortHandler) {
    var promiseState = promiseStateMap.get(promise);
    if (!promiseState) {
      promiseState = [true, new Set];
      promiseStateMap.set(promise, promiseState);
      var settle = function settle2() {
        promiseState[0] = false;
      };
      promise.then(settle, settle);
    }
    promiseState[1].add(abortHandler);
  }
  function isPromiseLike(p) {
    return typeof (p == null ? undefined : p.then) === "function";
  }
  function addPendingPromiseToDependency(atom, promise, dependencyAtomState) {
    if (!dependencyAtomState.p.has(atom)) {
      dependencyAtomState.p.add(atom);
      var cleanup = function cleanup2() {
        return dependencyAtomState.p.delete(atom);
      };
      promise.then(cleanup, cleanup);
    }
  }
  function getMountedOrPendingDependents(atom, atomState, mountedMap) {
    var dependents = new Set;
    for (var _iterator = _createForOfIteratorHelperLoose(((_mountedMap$get = mountedMap.get(atom)) == null ? undefined : _mountedMap$get.t) || []), _step;!(_step = _iterator()).done; ) {
      var _mountedMap$get;
      var a = _step.value;
      dependents.add(a);
    }
    for (var _iterator2 = _createForOfIteratorHelperLoose(atomState.p), _step2;!(_step2 = _iterator2()).done; ) {
      var atomWithPendingPromise = _step2.value;
      dependents.add(atomWithPendingPromise);
    }
    return dependents;
  }
  var createStoreHook = function createStoreHook2() {
    var callbacks = new Set;
    var notify = function notify2() {
      return callbacks.forEach(function(fn) {
        return fn();
      });
    };
    notify.add = function(fn) {
      callbacks.add(fn);
      return function() {
        return callbacks.delete(fn);
      };
    };
    return notify;
  };
  var createStoreHookForAtoms = function createStoreHookForAtoms2() {
    var all = {};
    var callbacks = new WeakMap;
    var notify = function notify2(atom) {
      var _callbacks$get, _callbacks$get2;
      (_callbacks$get = callbacks.get(all)) == null || _callbacks$get.forEach(function(fn) {
        return fn(atom);
      });
      (_callbacks$get2 = callbacks.get(atom)) == null || _callbacks$get2.forEach(function(fn) {
        return fn();
      });
    };
    notify.add = function(atom, fn) {
      var key = atom || all;
      var fns = callbacks.get(key);
      if (!fns) {
        fns = new Set;
        callbacks.set(key, fns);
      }
      fns.add(fn);
      return function() {
        fns.delete(fn);
        if (!fns.size) {
          callbacks.delete(key);
        }
      };
    };
    return notify;
  };
  function initializeStoreHooks(storeHooks) {
    var _ref, _ref2, _ref3, _ref4, _ref5, _ref6;
    (_ref = storeHooks).i || (_ref.i = createStoreHookForAtoms());
    (_ref2 = storeHooks).r || (_ref2.r = createStoreHookForAtoms());
    (_ref3 = storeHooks).c || (_ref3.c = createStoreHookForAtoms());
    (_ref4 = storeHooks).m || (_ref4.m = createStoreHookForAtoms());
    (_ref5 = storeHooks).u || (_ref5.u = createStoreHookForAtoms());
    (_ref6 = storeHooks).f || (_ref6.f = createStoreHook());
    return storeHooks;
  }
  var BUILDING_BLOCK_atomRead = function BUILDING_BLOCK_atomRead2(_store, atom) {
    for (var _len = arguments.length, params = new Array(_len > 2 ? _len - 2 : 0), _key = 2;_key < _len; _key++) {
      params[_key - 2] = arguments[_key];
    }
    return atom.read.apply(atom, params);
  };
  var BUILDING_BLOCK_atomWrite = function BUILDING_BLOCK_atomWrite2(_store, atom) {
    for (var _len2 = arguments.length, params = new Array(_len2 > 2 ? _len2 - 2 : 0), _key2 = 2;_key2 < _len2; _key2++) {
      params[_key2 - 2] = arguments[_key2];
    }
    return atom.write.apply(atom, params);
  };
  var BUILDING_BLOCK_atomOnInit = function BUILDING_BLOCK_atomOnInit2(store, atom) {
    return atom.INTERNAL_onInit == null ? undefined : atom.INTERNAL_onInit(store);
  };
  var BUILDING_BLOCK_atomOnMount = function BUILDING_BLOCK_atomOnMount2(_store, atom, setAtom) {
    return atom.onMount == null ? undefined : atom.onMount(setAtom);
  };
  var BUILDING_BLOCK_ensureAtomState = function BUILDING_BLOCK_ensureAtomState2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var atomStateMap = buildingBlocks[0];
    var storeHooks = buildingBlocks[6];
    var atomOnInit = buildingBlocks[9];
    if (false) {}
    var atomState = atomStateMap.get(atom);
    if (!atomState) {
      atomState = {
        d: new Map,
        p: new Set,
        n: 0
      };
      atomStateMap.set(atom, atomState);
      storeHooks.i == null || storeHooks.i(atom);
      atomOnInit == null || atomOnInit(store, atom);
    }
    return atomState;
  };
  var BUILDING_BLOCK_flushCallbacks = function BUILDING_BLOCK_flushCallbacks2(store) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var changedAtoms = buildingBlocks[3];
    var mountCallbacks = buildingBlocks[4];
    var unmountCallbacks = buildingBlocks[5];
    var storeHooks = buildingBlocks[6];
    var recomputeInvalidatedAtoms = buildingBlocks[13];
    var errors = [];
    var call = function call2(fn) {
      try {
        fn();
      } catch (e) {
        errors.push(e);
      }
    };
    var _loop = function _loop2() {
      if (storeHooks.f) {
        call(storeHooks.f);
      }
      var callbacks = new Set;
      var add = callbacks.add.bind(callbacks);
      changedAtoms.forEach(function(atom) {
        var _mountedMap$get2;
        return (_mountedMap$get2 = mountedMap.get(atom)) == null ? undefined : _mountedMap$get2.l.forEach(add);
      });
      changedAtoms.clear();
      unmountCallbacks.forEach(add);
      unmountCallbacks.clear();
      mountCallbacks.forEach(add);
      mountCallbacks.clear();
      callbacks.forEach(call);
      if (changedAtoms.size) {
        recomputeInvalidatedAtoms(store);
      }
    };
    do {
      _loop();
    } while (changedAtoms.size || unmountCallbacks.size || mountCallbacks.size);
    if (errors.length) {
      throw new AggregateError(errors);
    }
  };
  var BUILDING_BLOCK_recomputeInvalidatedAtoms = function BUILDING_BLOCK_recomputeInvalidatedAtoms2(store) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var invalidatedAtoms = buildingBlocks[2];
    var changedAtoms = buildingBlocks[3];
    var ensureAtomState = buildingBlocks[11];
    var readAtomState = buildingBlocks[14];
    var mountDependencies = buildingBlocks[17];
    var topSortedReversed = [];
    var visiting = new WeakSet;
    var visited = new WeakSet;
    var stack = Array.from(changedAtoms);
    while (stack.length) {
      var a = stack[stack.length - 1];
      var aState = ensureAtomState(store, a);
      if (visited.has(a)) {
        stack.pop();
        continue;
      }
      if (visiting.has(a)) {
        if (invalidatedAtoms.get(a) === aState.n) {
          topSortedReversed.push([a, aState]);
        } else if (false) {}
        visited.add(a);
        stack.pop();
        continue;
      }
      visiting.add(a);
      for (var _iterator3 = _createForOfIteratorHelperLoose(getMountedOrPendingDependents(a, aState, mountedMap)), _step3;!(_step3 = _iterator3()).done; ) {
        var d = _step3.value;
        if (!visiting.has(d)) {
          stack.push(d);
        }
      }
    }
    for (var i = topSortedReversed.length - 1;i >= 0; --i) {
      var _ref7 = topSortedReversed[i], _a = _ref7[0], _aState = _ref7[1];
      var hasChangedDeps = false;
      for (var _iterator4 = _createForOfIteratorHelperLoose(_aState.d.keys()), _step4;!(_step4 = _iterator4()).done; ) {
        var dep = _step4.value;
        if (dep !== _a && changedAtoms.has(dep)) {
          hasChangedDeps = true;
          break;
        }
      }
      if (hasChangedDeps) {
        readAtomState(store, _a);
        mountDependencies(store, _a);
      }
      invalidatedAtoms.delete(_a);
    }
  };
  var storeMutationSet = new WeakSet;
  var BUILDING_BLOCK_readAtomState = function BUILDING_BLOCK_readAtomState2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var invalidatedAtoms = buildingBlocks[2];
    var changedAtoms = buildingBlocks[3];
    var storeHooks = buildingBlocks[6];
    var atomRead = buildingBlocks[7];
    var ensureAtomState = buildingBlocks[11];
    var flushCallbacks = buildingBlocks[12];
    var recomputeInvalidatedAtoms = buildingBlocks[13];
    var readAtomState = buildingBlocks[14];
    var writeAtomState = buildingBlocks[16];
    var mountDependencies = buildingBlocks[17];
    var setAtomStateValueOrPromise = buildingBlocks[20];
    var atomState = ensureAtomState(store, atom);
    if (isAtomStateInitialized(atomState)) {
      if (mountedMap.has(atom) && invalidatedAtoms.get(atom) !== atomState.n) {
        return atomState;
      }
      var hasChangedDeps = false;
      for (var _iterator5 = _createForOfIteratorHelperLoose(atomState.d), _step5;!(_step5 = _iterator5()).done; ) {
        var _step5$value = _step5.value, a = _step5$value[0], n = _step5$value[1];
        if (readAtomState(store, a).n !== n) {
          hasChangedDeps = true;
          break;
        }
      }
      if (!hasChangedDeps) {
        return atomState;
      }
    }
    atomState.d.clear();
    var isSync = true;
    function mountDependenciesIfAsync() {
      if (mountedMap.has(atom)) {
        mountDependencies(store, atom);
        recomputeInvalidatedAtoms(store);
        flushCallbacks(store);
      }
    }
    function getter(a2) {
      if (a2 === atom) {
        var _aState2 = ensureAtomState(store, a2);
        if (!isAtomStateInitialized(_aState2)) {
          if (hasInitialValue(a2)) {
            setAtomStateValueOrPromise(store, a2, a2.init);
          } else {
            throw new Error("no atom init");
          }
        }
        return returnAtomValue(_aState2);
      }
      var aState = readAtomState(store, a2);
      try {
        return returnAtomValue(aState);
      } finally {
        atomState.d.set(a2, aState.n);
        if (isPendingPromise(atomState.v)) {
          addPendingPromiseToDependency(atom, atomState.v, aState);
        }
        if (mountedMap.has(atom)) {
          var _mountedMap$get3;
          (_mountedMap$get3 = mountedMap.get(a2)) == null || _mountedMap$get3.t.add(atom);
        }
        if (!isSync) {
          mountDependenciesIfAsync();
        }
      }
    }
    var controller;
    var setSelf;
    var options = {
      get signal() {
        if (!controller) {
          controller = new AbortController;
        }
        return controller.signal;
      },
      get setSelf() {
        if (false) {}
        if (false) {}
        if (!setSelf && isActuallyWritableAtom(atom)) {
          setSelf = function setSelf2() {
            if (false) {}
            if (!isSync) {
              try {
                for (var _len3 = arguments.length, args = new Array(_len3), _key3 = 0;_key3 < _len3; _key3++) {
                  args[_key3] = arguments[_key3];
                }
                return writeAtomState.apply(undefined, [store, atom].concat(args));
              } finally {
                recomputeInvalidatedAtoms(store);
                flushCallbacks(store);
              }
            }
          };
        }
        return setSelf;
      }
    };
    var prevEpochNumber = atomState.n;
    try {
      if (false) {}
      var _valueOrPromise = atomRead(store, atom, getter, options);
      if (false) {}
      setAtomStateValueOrPromise(store, atom, _valueOrPromise);
      if (isPromiseLike(_valueOrPromise)) {
        registerAbortHandler(_valueOrPromise, function() {
          var _controller;
          return (_controller = controller) == null ? undefined : _controller.abort();
        });
        _valueOrPromise.then(mountDependenciesIfAsync, mountDependenciesIfAsync);
      }
      storeHooks.r == null || storeHooks.r(atom);
      return atomState;
    } catch (error) {
      delete atomState.v;
      atomState.e = error;
      ++atomState.n;
      return atomState;
    } finally {
      isSync = false;
      if (prevEpochNumber !== atomState.n && invalidatedAtoms.get(atom) === prevEpochNumber) {
        invalidatedAtoms.set(atom, atomState.n);
        changedAtoms.add(atom);
        storeHooks.c == null || storeHooks.c(atom);
      }
    }
  };
  var BUILDING_BLOCK_invalidateDependents = function BUILDING_BLOCK_invalidateDependents2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var invalidatedAtoms = buildingBlocks[2];
    var ensureAtomState = buildingBlocks[11];
    var stack = [atom];
    while (stack.length) {
      var a = stack.pop();
      var aState = ensureAtomState(store, a);
      for (var _iterator6 = _createForOfIteratorHelperLoose(getMountedOrPendingDependents(a, aState, mountedMap)), _step6;!(_step6 = _iterator6()).done; ) {
        var d = _step6.value;
        var dState = ensureAtomState(store, d);
        invalidatedAtoms.set(d, dState.n);
        stack.push(d);
      }
    }
  };
  var BUILDING_BLOCK_writeAtomState = function BUILDING_BLOCK_writeAtomState2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var changedAtoms = buildingBlocks[3];
    var storeHooks = buildingBlocks[6];
    var atomWrite = buildingBlocks[8];
    var ensureAtomState = buildingBlocks[11];
    var flushCallbacks = buildingBlocks[12];
    var recomputeInvalidatedAtoms = buildingBlocks[13];
    var readAtomState = buildingBlocks[14];
    var invalidateDependents = buildingBlocks[15];
    var writeAtomState = buildingBlocks[16];
    var mountDependencies = buildingBlocks[17];
    var setAtomStateValueOrPromise = buildingBlocks[20];
    var isSync = true;
    var getter = function getter2(a) {
      return returnAtomValue(readAtomState(store, a));
    };
    var setter = function setter2(a) {
      var aState = ensureAtomState(store, a);
      try {
        for (var _len5 = arguments.length, args2 = new Array(_len5 > 1 ? _len5 - 1 : 0), _key5 = 1;_key5 < _len5; _key5++) {
          args2[_key5 - 1] = arguments[_key5];
        }
        if (a === atom) {
          if (!hasInitialValue(a)) {
            throw new Error("atom not writable");
          }
          if (false) {}
          var prevEpochNumber = aState.n;
          var v = args2[0];
          setAtomStateValueOrPromise(store, a, v);
          mountDependencies(store, a);
          if (prevEpochNumber !== aState.n) {
            changedAtoms.add(a);
            invalidateDependents(store, a);
            storeHooks.c == null || storeHooks.c(a);
          }
          return;
        } else {
          return writeAtomState.apply(undefined, [store, a].concat(args2));
        }
      } finally {
        if (!isSync) {
          recomputeInvalidatedAtoms(store);
          flushCallbacks(store);
        }
      }
    };
    try {
      for (var _len4 = arguments.length, args = new Array(_len4 > 2 ? _len4 - 2 : 0), _key4 = 2;_key4 < _len4; _key4++) {
        args[_key4 - 2] = arguments[_key4];
      }
      return atomWrite.apply(undefined, [store, atom, getter, setter].concat(args));
    } finally {
      isSync = false;
    }
  };
  var BUILDING_BLOCK_mountDependencies = function BUILDING_BLOCK_mountDependencies2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var changedAtoms = buildingBlocks[3];
    var storeHooks = buildingBlocks[6];
    var ensureAtomState = buildingBlocks[11];
    var invalidateDependents = buildingBlocks[15];
    var mountAtom = buildingBlocks[18];
    var unmountAtom = buildingBlocks[19];
    var atomState = ensureAtomState(store, atom);
    var mounted = mountedMap.get(atom);
    if (mounted && !isPendingPromise(atomState.v)) {
      for (var _iterator7 = _createForOfIteratorHelperLoose(atomState.d), _step7;!(_step7 = _iterator7()).done; ) {
        var _step7$value = _step7.value, a = _step7$value[0], n = _step7$value[1];
        if (!mounted.d.has(a)) {
          var aState = ensureAtomState(store, a);
          var aMounted = mountAtom(store, a);
          aMounted.t.add(atom);
          mounted.d.add(a);
          if (n !== aState.n) {
            changedAtoms.add(a);
            invalidateDependents(store, a);
            storeHooks.c == null || storeHooks.c(a);
          }
        }
      }
      for (var _iterator8 = _createForOfIteratorHelperLoose(mounted.d), _step8;!(_step8 = _iterator8()).done; ) {
        var _a2 = _step8.value;
        if (!atomState.d.has(_a2)) {
          mounted.d.delete(_a2);
          var _aMounted = unmountAtom(store, _a2);
          _aMounted == null || _aMounted.t.delete(atom);
        }
      }
    }
  };
  var BUILDING_BLOCK_mountAtom = function BUILDING_BLOCK_mountAtom2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var mountCallbacks = buildingBlocks[4];
    var storeHooks = buildingBlocks[6];
    var atomOnMount = buildingBlocks[10];
    var ensureAtomState = buildingBlocks[11];
    var flushCallbacks = buildingBlocks[12];
    var recomputeInvalidatedAtoms = buildingBlocks[13];
    var readAtomState = buildingBlocks[14];
    var writeAtomState = buildingBlocks[16];
    var mountAtom = buildingBlocks[18];
    var atomState = ensureAtomState(store, atom);
    var mounted = mountedMap.get(atom);
    if (!mounted) {
      readAtomState(store, atom);
      for (var _iterator9 = _createForOfIteratorHelperLoose(atomState.d.keys()), _step9;!(_step9 = _iterator9()).done; ) {
        var a = _step9.value;
        var aMounted = mountAtom(store, a);
        aMounted.t.add(atom);
      }
      mounted = {
        l: new Set,
        d: new Set(atomState.d.keys()),
        t: new Set
      };
      mountedMap.set(atom, mounted);
      if (isActuallyWritableAtom(atom)) {
        var processOnMount = function processOnMount2() {
          var isSync = true;
          var setAtom = function setAtom2() {
            try {
              for (var _len6 = arguments.length, args = new Array(_len6), _key6 = 0;_key6 < _len6; _key6++) {
                args[_key6] = arguments[_key6];
              }
              return writeAtomState.apply(undefined, [store, atom].concat(args));
            } finally {
              if (!isSync) {
                recomputeInvalidatedAtoms(store);
                flushCallbacks(store);
              }
            }
          };
          try {
            var onUnmount = atomOnMount(store, atom, setAtom);
            if (onUnmount) {
              mounted.u = function() {
                isSync = true;
                try {
                  onUnmount();
                } finally {
                  isSync = false;
                }
              };
            }
          } finally {
            isSync = false;
          }
        };
        mountCallbacks.add(processOnMount);
      }
      storeHooks.m == null || storeHooks.m(atom);
    }
    return mounted;
  };
  var BUILDING_BLOCK_unmountAtom = function BUILDING_BLOCK_unmountAtom2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var mountedMap = buildingBlocks[1];
    var unmountCallbacks = buildingBlocks[5];
    var storeHooks = buildingBlocks[6];
    var ensureAtomState = buildingBlocks[11];
    var unmountAtom = buildingBlocks[19];
    var atomState = ensureAtomState(store, atom);
    var mounted = mountedMap.get(atom);
    if (!mounted || mounted.l.size) {
      return mounted;
    }
    var isDependent = false;
    for (var _iterator0 = _createForOfIteratorHelperLoose(mounted.t), _step0;!(_step0 = _iterator0()).done; ) {
      var _mountedMap$get4;
      var _a3 = _step0.value;
      if ((_mountedMap$get4 = mountedMap.get(_a3)) != null && _mountedMap$get4.d.has(atom)) {
        isDependent = true;
        break;
      }
    }
    if (!isDependent) {
      if (mounted.u) {
        unmountCallbacks.add(mounted.u);
      }
      mounted = undefined;
      mountedMap.delete(atom);
      for (var _iterator1 = _createForOfIteratorHelperLoose(atomState.d.keys()), _step1;!(_step1 = _iterator1()).done; ) {
        var a = _step1.value;
        var aMounted = unmountAtom(store, a);
        aMounted == null || aMounted.t.delete(atom);
      }
      storeHooks.u == null || storeHooks.u(atom);
      return;
    }
    return mounted;
  };
  var BUILDING_BLOCK_setAtomStateValueOrPromise = function BUILDING_BLOCK_setAtomStateValueOrPromise2(store, atom, valueOrPromise) {
    var ensureAtomState = getInternalBuildingBlocks(store)[11];
    var atomState = ensureAtomState(store, atom);
    var hasPrevValue = "v" in atomState;
    var prevValue = atomState.v;
    if (isPromiseLike(valueOrPromise)) {
      for (var _iterator10 = _createForOfIteratorHelperLoose(atomState.d.keys()), _step10;!(_step10 = _iterator10()).done; ) {
        var a = _step10.value;
        addPendingPromiseToDependency(atom, valueOrPromise, ensureAtomState(store, a));
      }
    }
    atomState.v = valueOrPromise;
    delete atomState.e;
    if (!hasPrevValue || !Object.is(prevValue, atomState.v)) {
      ++atomState.n;
      if (isPromiseLike(prevValue)) {
        abortPromise(prevValue);
      }
    }
  };
  var BUILDING_BLOCK_storeGet = function BUILDING_BLOCK_storeGet2(store, atom) {
    var readAtomState = getInternalBuildingBlocks(store)[14];
    return returnAtomValue(readAtomState(store, atom));
  };
  var BUILDING_BLOCK_storeSet = function BUILDING_BLOCK_storeSet2(store, atom) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var flushCallbacks = buildingBlocks[12];
    var recomputeInvalidatedAtoms = buildingBlocks[13];
    var writeAtomState = buildingBlocks[16];
    try {
      for (var _len7 = arguments.length, args = new Array(_len7 > 2 ? _len7 - 2 : 0), _key7 = 2;_key7 < _len7; _key7++) {
        args[_key7 - 2] = arguments[_key7];
      }
      return writeAtomState.apply(undefined, [store, atom].concat(args));
    } finally {
      recomputeInvalidatedAtoms(store);
      flushCallbacks(store);
    }
  };
  var BUILDING_BLOCK_storeSub = function BUILDING_BLOCK_storeSub2(store, atom, listener) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var flushCallbacks = buildingBlocks[12];
    var mountAtom = buildingBlocks[18];
    var unmountAtom = buildingBlocks[19];
    var mounted = mountAtom(store, atom);
    var listeners = mounted.l;
    listeners.add(listener);
    flushCallbacks(store);
    return function() {
      listeners.delete(listener);
      unmountAtom(store, atom);
      flushCallbacks(store);
    };
  };
  var buildingBlockMap = new WeakMap;
  var getInternalBuildingBlocks = function getInternalBuildingBlocks2(store) {
    var buildingBlocks = buildingBlockMap.get(store);
    if (false) {}
    return buildingBlocks;
  };
  function getBuildingBlocks(store) {
    var buildingBlocks = getInternalBuildingBlocks(store);
    var enhanceBuildingBlocks = buildingBlocks[24];
    if (enhanceBuildingBlocks) {
      return enhanceBuildingBlocks(buildingBlocks);
    }
    return buildingBlocks;
  }
  function buildStore() {
    for (var _len8 = arguments.length, buildArgs = new Array(_len8), _key8 = 0;_key8 < _len8; _key8++) {
      buildArgs[_key8] = arguments[_key8];
    }
    var store = {
      get: function get(atom) {
        var storeGet = getInternalBuildingBlocks(store)[21];
        return storeGet(store, atom);
      },
      set: function set(atom) {
        var storeSet = getInternalBuildingBlocks(store)[22];
        for (var _len9 = arguments.length, args = new Array(_len9 > 1 ? _len9 - 1 : 0), _key9 = 1;_key9 < _len9; _key9++) {
          args[_key9 - 1] = arguments[_key9];
        }
        return storeSet.apply(undefined, [store, atom].concat(args));
      },
      sub: function sub(atom, listener) {
        var storeSub = getInternalBuildingBlocks(store)[23];
        return storeSub(store, atom, listener);
      }
    };
    var buildingBlocks = [new WeakMap, new WeakMap, new WeakMap, new Set, new Set, new Set, {}, BUILDING_BLOCK_atomRead, BUILDING_BLOCK_atomWrite, BUILDING_BLOCK_atomOnInit, BUILDING_BLOCK_atomOnMount, BUILDING_BLOCK_ensureAtomState, BUILDING_BLOCK_flushCallbacks, BUILDING_BLOCK_recomputeInvalidatedAtoms, BUILDING_BLOCK_readAtomState, BUILDING_BLOCK_invalidateDependents, BUILDING_BLOCK_writeAtomState, BUILDING_BLOCK_mountDependencies, BUILDING_BLOCK_mountAtom, BUILDING_BLOCK_unmountAtom, BUILDING_BLOCK_setAtomStateValueOrPromise, BUILDING_BLOCK_storeGet, BUILDING_BLOCK_storeSet, BUILDING_BLOCK_storeSub, undefined].map(function(fn, i) {
      return buildArgs[i] || fn;
    });
    buildingBlockMap.set(store, Object.freeze(buildingBlocks));
    return store;
  }
  exports2.INTERNAL_abortPromise = abortPromise;
  exports2.INTERNAL_addPendingPromiseToDependency = addPendingPromiseToDependency;
  exports2.INTERNAL_buildStoreRev2 = buildStore;
  exports2.INTERNAL_getBuildingBlocksRev2 = getBuildingBlocks;
  exports2.INTERNAL_getMountedOrPendingDependents = getMountedOrPendingDependents;
  exports2.INTERNAL_hasInitialValue = hasInitialValue;
  exports2.INTERNAL_initializeStoreHooksRev2 = initializeStoreHooks;
  exports2.INTERNAL_isActuallyWritableAtom = isActuallyWritableAtom;
  exports2.INTERNAL_isAtomStateInitialized = isAtomStateInitialized;
  exports2.INTERNAL_isPendingPromise = isPendingPromise;
  exports2.INTERNAL_isPromiseLike = isPromiseLike;
  exports2.INTERNAL_promiseStateMap = promiseStateMap;
  exports2.INTERNAL_registerAbortHandler = registerAbortHandler;
  exports2.INTERNAL_returnAtomValue = returnAtomValue;
});

// ../../node_modules/jotai/vanilla.js
var require_vanilla = __commonJS((exports2) => {
  var internals = require_internals();
  var keyCount = 0;
  function atom(read, write) {
    var key = "atom" + ++keyCount;
    var config = {
      toString: function toString() {
        return key;
      }
    };
    if (typeof read === "function") {
      config.read = read;
    } else {
      config.init = read;
      config.read = defaultRead;
      config.write = defaultWrite;
    }
    if (write) {
      config.write = write;
    }
    return config;
  }
  function defaultRead(get) {
    return get(this);
  }
  function defaultWrite(get, set, arg) {
    return set(this, typeof arg === "function" ? arg(get(this)) : arg);
  }
  var overriddenCreateStore;
  function INTERNAL_overrideCreateStore(fn) {
    overriddenCreateStore = fn(overriddenCreateStore);
  }
  function createStore() {
    if (overriddenCreateStore) {
      return overriddenCreateStore();
    }
    return internals.INTERNAL_buildStoreRev2();
  }
  var defaultStore;
  function getDefaultStore() {
    if (!defaultStore) {
      defaultStore = createStore();
      if (false) {
        var _ref;
      }
    }
    return defaultStore;
  }
  exports2.INTERNAL_overrideCreateStore = INTERNAL_overrideCreateStore;
  exports2.atom = atom;
  exports2.createStore = createStore;
  exports2.getDefaultStore = getDefaultStore;
});

// ../../node_modules/jotai/react.js
var require_react = __commonJS((exports2) => {
  "use client";
  var React = require("react");
  var vanilla = require_vanilla();
  var internals = require_internals();
  var StoreContext = React.createContext(undefined);
  function useStore(options) {
    var store = React.useContext(StoreContext);
    return (options == null ? undefined : options.store) || store || vanilla.getDefaultStore();
  }
  function Provider(_ref) {
    var { children, store } = _ref;
    var storeRef = React.useRef(null);
    if (store) {
      return React.createElement(StoreContext.Provider, {
        value: store
      }, children);
    }
    if (storeRef.current === null) {
      storeRef.current = vanilla.createStore();
    }
    return React.createElement(StoreContext.Provider, {
      value: storeRef.current
    }, children);
  }
  var isPromiseLike = function isPromiseLike2(x) {
    return typeof (x == null ? undefined : x.then) === "function";
  };
  var attachPromiseStatus = function attachPromiseStatus2(promise) {
    if (!promise.status) {
      promise.status = "pending";
      promise.then(function(v) {
        promise.status = "fulfilled";
        promise.value = v;
      }, function(e) {
        promise.status = "rejected";
        promise.reason = e;
      });
    }
  };
  var use = React.use || function(promise) {
    if (promise.status === "pending") {
      throw promise;
    } else if (promise.status === "fulfilled") {
      return promise.value;
    } else if (promise.status === "rejected") {
      throw promise.reason;
    } else {
      attachPromiseStatus(promise);
      throw promise;
    }
  };
  var continuablePromiseMap = new WeakMap;
  var createContinuablePromise = function createContinuablePromise2(promise, getValue) {
    var continuablePromise = continuablePromiseMap.get(promise);
    if (!continuablePromise) {
      continuablePromise = new Promise(function(resolve, reject) {
        var curr = promise;
        var onFulfilled = function onFulfilled2(me) {
          return function(v) {
            if (curr === me) {
              resolve(v);
            }
          };
        };
        var onRejected = function onRejected2(me) {
          return function(e) {
            if (curr === me) {
              reject(e);
            }
          };
        };
        var _onAbort = function onAbort() {
          try {
            var nextValue = getValue();
            if (isPromiseLike(nextValue)) {
              continuablePromiseMap.set(nextValue, continuablePromise);
              curr = nextValue;
              nextValue.then(onFulfilled(nextValue), onRejected(nextValue));
              internals.INTERNAL_registerAbortHandler(nextValue, _onAbort);
            } else {
              resolve(nextValue);
            }
          } catch (e) {
            reject(e);
          }
        };
        promise.then(onFulfilled(promise), onRejected(promise));
        internals.INTERNAL_registerAbortHandler(promise, _onAbort);
      });
      continuablePromiseMap.set(promise, continuablePromise);
    }
    return continuablePromise;
  };
  function useAtomValue(atom, options) {
    var _ref = options || {}, delay = _ref.delay, _ref$unstable_promise = _ref.unstable_promiseStatus, promiseStatus = _ref$unstable_promise === undefined ? !React.use : _ref$unstable_promise;
    var store = useStore(options);
    var _useReducer = React.useReducer(function(prev) {
      var nextValue = store.get(atom);
      if (Object.is(prev[0], nextValue) && prev[1] === store && prev[2] === atom) {
        return prev;
      }
      return [nextValue, store, atom];
    }, undefined, function() {
      return [store.get(atom), store, atom];
    }), _useReducer$ = _useReducer[0], valueFromReducer = _useReducer$[0], storeFromReducer = _useReducer$[1], atomFromReducer = _useReducer$[2], rerender = _useReducer[1];
    var value = valueFromReducer;
    if (storeFromReducer !== store || atomFromReducer !== atom) {
      rerender();
      value = store.get(atom);
    }
    React.useEffect(function() {
      var unsub = store.sub(atom, function() {
        if (promiseStatus) {
          try {
            var _value = store.get(atom);
            if (isPromiseLike(_value)) {
              attachPromiseStatus(createContinuablePromise(_value, function() {
                return store.get(atom);
              }));
            }
          } catch (_unused) {}
        }
        if (typeof delay === "number") {
          setTimeout(rerender, delay);
          return;
        }
        rerender();
      });
      rerender();
      return unsub;
    }, [store, atom, delay, promiseStatus]);
    React.useDebugValue(value);
    if (isPromiseLike(value)) {
      var promise = createContinuablePromise(value, function() {
        return store.get(atom);
      });
      if (promiseStatus) {
        attachPromiseStatus(promise);
      }
      return use(promise);
    }
    return value;
  }
  function useSetAtom(atom, options) {
    var store = useStore(options);
    var setAtom = React.useCallback(function() {
      if (false) {}
      for (var _len = arguments.length, args = new Array(_len), _key = 0;_key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      return store.set.apply(store, [atom].concat(args));
    }, [store, atom]);
    return setAtom;
  }
  function useAtom(atom, options) {
    return [useAtomValue(atom, options), useSetAtom(atom, options)];
  }
  exports2.Provider = Provider;
  exports2.useAtom = useAtom;
  exports2.useAtomValue = useAtomValue;
  exports2.useSetAtom = useSetAtom;
  exports2.useStore = useStore;
});

// ../../node_modules/jotai/index.js
var require_jotai = __commonJS((exports2) => {
  var vanilla = require_vanilla();
  var react = require_react();
  Object.keys(vanilla).forEach(function(k) {
    if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports2, k))
      Object.defineProperty(exports2, k, {
        enumerable: true,
        get: function() {
          return vanilla[k];
        }
      });
  });
  Object.keys(react).forEach(function(k) {
    if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports2, k))
      Object.defineProperty(exports2, k, {
        enumerable: true,
        get: function() {
          return react[k];
        }
      });
  });
});

// dsh-plugins/copis-creation-web/src/client.tsx
var exports_client = {};
__export(exports_client, {
  inject: () => inject,
  apply: () => apply,
  CreationSidebarNavigation: () => CreationSidebarNavigation,
  CopisShellOverlayManager: () => CopisShellOverlayManager,
  CopisSearchModal: () => CopisSearchModal
});
module.exports = __toCommonJS(exports_client);

// ../../packages/shared/src/types/dsh.ts
var DEFAULT_DSH_PINNED_MENU_IDS = ["search", "schedule", "automations"];
var DSH_SIDEBAR_MIN_WIDTH = 264;
var DSH_SIDEBAR_MAX_WIDTH = 420;
function isDshExpandedSidebarWidth(width) {
  return typeof width === "number" && width >= DSH_SIDEBAR_MIN_WIDTH && width <= DSH_SIDEBAR_MAX_WIDTH;
}
var ROOM_ACTION_LABELS = { roster: "群智能体", copy: "复制分享码", leave: "退出群", dissolve: "解散群" };

// ../../node_modules/lucide-react/dist/esm/createLucideIcon.js
var import_react2 = require("react");

// ../../node_modules/lucide-react/dist/esm/shared/src/utils.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();

// ../../node_modules/lucide-react/dist/esm/Icon.js
var import_react = require("react");

// ../../node_modules/lucide-react/dist/esm/defaultAttributes.js
var defaultAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

// ../../node_modules/lucide-react/dist/esm/Icon.js
var Icon = import_react.forwardRef(({
  color = "currentColor",
  size = 24,
  strokeWidth = 2,
  absoluteStrokeWidth,
  className = "",
  children,
  iconNode,
  ...rest
}, ref) => {
  return import_react.createElement("svg", {
    ref,
    ...defaultAttributes,
    width: size,
    height: size,
    stroke: color,
    strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
    className: mergeClasses("lucide", className),
    ...rest
  }, [
    ...iconNode.map(([tag, attrs]) => import_react.createElement(tag, attrs)),
    ...Array.isArray(children) ? children : [children]
  ]);
});

// ../../node_modules/lucide-react/dist/esm/createLucideIcon.js
var createLucideIcon = (iconName, iconNode) => {
  const Component = import_react2.forwardRef(({ className, ...props }, ref) => import_react2.createElement(Icon, {
    ref,
    iconNode,
    className: mergeClasses(`lucide-${toKebabCase(iconName)}`, className),
    ...props
  }));
  Component.displayName = `${iconName}`;
  return Component;
};

// ../../node_modules/lucide-react/dist/esm/icons/book-open.js
var BookOpen = createLucideIcon("BookOpen", [
  ["path", { d: "M12 7v14", key: "1akyts" }],
  [
    "path",
    {
      d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
      key: "ruj8y"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/brain.js
var Brain = createLucideIcon("Brain", [
  [
    "path",
    {
      d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
      key: "l5xja"
    }
  ],
  [
    "path",
    {
      d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
      key: "ep3f8r"
    }
  ],
  ["path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4", key: "1p4c4q" }],
  ["path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375", key: "tmeiqw" }],
  ["path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5", key: "105sqy" }],
  ["path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396", key: "ql3yin" }],
  ["path", { d: "M19.938 10.5a4 4 0 0 1 .585.396", key: "1qfode" }],
  ["path", { d: "M6 18a4 4 0 0 1-1.967-.516", key: "2e4loj" }],
  ["path", { d: "M19.967 17.484A4 4 0 0 1 18 18", key: "159ez6" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/calendar-clock.js
var CalendarClock = createLucideIcon("CalendarClock", [
  ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5", key: "1osxxc" }],
  ["path", { d: "M16 2v4", key: "4m81vk" }],
  ["path", { d: "M8 2v4", key: "1cmpym" }],
  ["path", { d: "M3 10h5", key: "r794hk" }],
  ["path", { d: "M17.5 17.5 16 16.3V14", key: "akvzfd" }],
  ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/chevron-down.js
var ChevronDown = createLucideIcon("ChevronDown", [
  ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/chevron-right.js
var ChevronRight = createLucideIcon("ChevronRight", [
  ["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/chevron-up.js
var ChevronUp = createLucideIcon("ChevronUp", [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]]);

// ../../node_modules/lucide-react/dist/esm/icons/copy.js
var Copy = createLucideIcon("Copy", [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/ellipsis.js
var Ellipsis = createLucideIcon("Ellipsis", [
  ["circle", { cx: "12", cy: "12", r: "1", key: "41hilf" }],
  ["circle", { cx: "19", cy: "12", r: "1", key: "1wjl8i" }],
  ["circle", { cx: "5", cy: "12", r: "1", key: "1pcz8c" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/layout-grid.js
var LayoutGrid = createLucideIcon("LayoutGrid", [
  ["rect", { width: "7", height: "7", x: "3", y: "3", rx: "1", key: "1g98yp" }],
  ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1", key: "6d4xhi" }],
  ["rect", { width: "7", height: "7", x: "14", y: "14", rx: "1", key: "nxv5o0" }],
  ["rect", { width: "7", height: "7", x: "3", y: "14", rx: "1", key: "1bb6yr" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/log-in.js
var LogIn = createLucideIcon("LogIn", [
  ["path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", key: "u53s6r" }],
  ["polyline", { points: "10 17 15 12 10 7", key: "1ail0h" }],
  ["line", { x1: "15", x2: "3", y1: "12", y2: "12", key: "v6grx8" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/log-out.js
var LogOut = createLucideIcon("LogOut", [
  ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", key: "1uf3rs" }],
  ["polyline", { points: "16 17 21 12 16 7", key: "1gabdz" }],
  ["line", { x1: "21", x2: "9", y1: "12", y2: "12", key: "1uyos4" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/message-square-plus.js
var MessageSquarePlus = createLucideIcon("MessageSquarePlus", [
  ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", key: "1lielz" }],
  ["path", { d: "M12 7v6", key: "lw1j43" }],
  ["path", { d: "M9 10h6", key: "9gxzsh" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/plus.js
var Plus = createLucideIcon("Plus", [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/puzzle.js
var Puzzle = createLucideIcon("Puzzle", [
  [
    "path",
    {
      d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
      key: "w46dr5"
    }
  ]
]);

// ../../node_modules/lucide-react/dist/esm/icons/rotate-cw.js
var RotateCw = createLucideIcon("RotateCw", [
  ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", key: "1p45f6" }],
  ["path", { d: "M21 3v5h-5", key: "1q7to0" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/search.js
var Search = createLucideIcon("Search", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/settings.js
var Settings = createLucideIcon("Settings", [
  [
    "path",
    {
      d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      key: "1qme2f"
    }
  ],
  ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/timer.js
var Timer = createLucideIcon("Timer", [
  ["line", { x1: "10", x2: "14", y1: "2", y2: "2", key: "14vaq8" }],
  ["line", { x1: "12", x2: "15", y1: "14", y2: "11", key: "17fdiu" }],
  ["circle", { cx: "12", cy: "14", r: "8", key: "1e1u0o" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/trash-2.js
var Trash2 = createLucideIcon("Trash2", [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/trending-up.js
var TrendingUp = createLucideIcon("TrendingUp", [
  ["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17", key: "126l90" }],
  ["polyline", { points: "16 7 22 7 22 13", key: "kwv8wd" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/users-round.js
var UsersRound = createLucideIcon("UsersRound", [
  ["path", { d: "M18 21a8 8 0 0 0-16 0", key: "3ypg7q" }],
  ["circle", { cx: "10", cy: "8", r: "5", key: "o932ke" }],
  ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3", key: "10s06x" }]
]);

// ../../node_modules/lucide-react/dist/esm/icons/x.js
var X = createLucideIcon("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]);
// dsh-plugins/copis-creation-web/src/client.tsx
var import_react5 = require("react");
var import_react_dom = require("react-dom");

// dsh-plugins/copis-creation-web/src/SharedRoomSection.tsx
var import_react3 = require("react");
var jsx_runtime = require("react/jsx-runtime");
var empty = {
  type: "COPIS_SHARED_ROOM_SIDEBAR",
  status: "loading",
  rooms: [],
  epoch: -1,
  selected: null,
  busy: false
};
var moreIcons = { roster: UsersRound, copy: Copy, leave: LogOut, dissolve: Trash2 };
function RoomActionMenu({ disabled, label, menuLabel, row, items, choose }) {
  const anchor = "--copis-room-" + import_react3.useId().replace(/[^a-z0-9_-]/gi, "");
  const [open, setOpen] = import_react3.useState(false);
  const root = import_react3.useRef(null);
  const menu = import_react3.useRef(null);
  const trigger = import_react3.useRef(null);
  import_react3.useLayoutEffect(() => {
    if (!open)
      return;
    if (disabled) {
      setOpen(false);
      return;
    }
    const panel = menu.current;
    panel.popover = "manual";
    panel.showPopover();
    panel.querySelector("button")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target))
        setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [open, disabled]);
  return /* @__PURE__ */ jsx_runtime.jsxs("div", {
    ref: root,
    style: { "--copis-room-anchor": anchor },
    onKeyDown: (e) => {
      if (!open)
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items2 = Array.from(menu.current.querySelectorAll("button"));
        const index = items2.indexOf(document.activeElement);
        items2[(index + (e.key === "ArrowDown" ? 1 : -1) + items2.length) % items2.length]?.focus();
      }
    },
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget))
        setOpen(false);
    },
    children: [
      /* @__PURE__ */ jsx_runtime.jsx("button", {
        ref: trigger,
        type: "button",
        className: row ? "copis-room-action copis-room-more" : "copis-room-action",
        disabled,
        "aria-label": label,
        title: label,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        children: row ? /* @__PURE__ */ jsx_runtime.jsx(Ellipsis, {}) : /* @__PURE__ */ jsx_runtime.jsx(Plus, {})
      }),
      open && /* @__PURE__ */ jsx_runtime.jsx("div", {
        ref: menu,
        role: "menu",
        "aria-label": menuLabel,
        className: "copis-room-action-menu",
        children: items.map(([tab, label2, Icon2]) => /* @__PURE__ */ jsx_runtime.jsxs("button", {
          type: "button",
          role: "menuitem",
          "aria-label": label2,
          onClick: () => {
            setOpen(false);
            choose(tab);
          },
          children: [
            /* @__PURE__ */ jsx_runtime.jsx(Icon2, {
              "aria-hidden": "true"
            }),
            label2
          ]
        }, tab))
      })
    ]
  });
}
function SharedRoomSection({ wide, active, open, directory }) {
  const unreadDescriptionId = import_react3.useId();
  const [expanded, setExpanded] = import_react3.useState(true);
  const [snapshot, setSnapshot] = import_react3.useState(empty);
  import_react3.useEffect(() => {
    const onSnapshot = (e) => {
      if (e.source && e.source !== window || e.origin && e.origin !== window.location.origin)
        return;
      const s = e.data;
      if (s?.type !== empty.type || !Array.isArray(s.rooms) || !s.rooms.every((r) => typeof r?.id === "string" && typeof r.name === "string"))
        return;
      setSnapshot({
        type: empty.type,
        epoch: Number.isSafeInteger(s.epoch) ? s.epoch : -1,
        status: s.status ?? "loading",
        rooms: s.rooms,
        selected: s.selected ?? null,
        busy: s.busy === true
      });
    };
    window.addEventListener("message", onSnapshot);
    directory("sidebar-sync");
    return () => window.removeEventListener("message", onSnapshot);
  }, [directory]);
  const disabled = snapshot.busy || snapshot.status === "signed-out";
  const hasUnread = snapshot.rooms.some((room) => room.unread === true);
  if (!wide)
    return /* @__PURE__ */ jsx_runtime.jsxs("button", {
      type: "button",
      className: "copis-rail-menu-item copis-workspace-group-entry",
      "aria-label": "群聊协作",
      "aria-describedby": hasUnread ? unreadDescriptionId : undefined,
      title: "群聊协作",
      "data-active": active,
      onClick: () => {
        setExpanded(true);
        open();
      },
      children: [
        /* @__PURE__ */ jsx_runtime.jsx(UsersRound, {
          size: 16
        }),
        hasUnread && /* @__PURE__ */ jsx_runtime.jsxs(jsx_runtime.Fragment, {
          children: [
            /* @__PURE__ */ jsx_runtime.jsx("span", {
              className: "copis-room-unread-dot",
              "aria-hidden": "true"
            }),
            /* @__PURE__ */ jsx_runtime.jsx("span", {
              id: unreadDescriptionId,
              className: "copis-room-sr-only",
              children: "有未读消息"
            })
          ]
        })
      ]
    });
  return /* @__PURE__ */ jsx_runtime.jsxs("section", {
    className: "copis-room-section",
    "aria-label": "群聊协作目录",
    children: [
      hasUnread && /* @__PURE__ */ jsx_runtime.jsx("span", {
        id: unreadDescriptionId,
        className: "copis-room-sr-only",
        children: "有未读消息"
      }),
      /* @__PURE__ */ jsx_runtime.jsxs("div", {
        className: "copis-room-heading",
        children: [
          /* @__PURE__ */ jsx_runtime.jsxs("button", {
            type: "button",
            className: "copis-menu-item copis-room-toggle",
            "aria-label": "群聊协作",
            "aria-describedby": !expanded && hasUnread ? unreadDescriptionId : undefined,
            "aria-expanded": expanded,
            onClick: () => {
              if (!expanded && !disabled)
                directory("refresh");
              setExpanded(!expanded);
            },
            children: [
              expanded ? /* @__PURE__ */ jsx_runtime.jsx(ChevronDown, {}) : /* @__PURE__ */ jsx_runtime.jsx(ChevronRight, {}),
              !expanded && hasUnread && /* @__PURE__ */ jsx_runtime.jsx("span", {
                className: "copis-room-unread-slot",
                "aria-hidden": "true",
                children: /* @__PURE__ */ jsx_runtime.jsx("span", {
                  className: "copis-room-unread-dot"
                })
              }),
              /* @__PURE__ */ jsx_runtime.jsx("span", {
                className: "copis-room-heading-label",
                children: "群聊协作"
              })
            ]
          }),
          /* @__PURE__ */ jsx_runtime.jsx(RoomActionMenu, {
            disabled,
            label: "群聊操作",
            menuLabel: "群聊操作菜单",
            items: [["create", "创建群聊", MessageSquarePlus], ["join", "加入群聊", LogIn]],
            choose: (tab) => {
              setExpanded(true);
              open(tab);
            }
          })
        ]
      }),
      expanded && /* @__PURE__ */ jsx_runtime.jsxs("div", {
        className: "copis-room-children",
        "aria-label": "我的共享群",
        children: [
          snapshot.rooms.map((room) => /* @__PURE__ */ jsx_runtime.jsxs("div", {
            className: "copis-room-row",
            children: [
              /* @__PURE__ */ jsx_runtime.jsxs("button", {
                type: "button",
                className: "copis-menu-item",
                disabled: snapshot.busy,
                "data-active": active && snapshot.selected === room.id,
                "aria-current": active && snapshot.selected === room.id ? "page" : undefined,
                "aria-label": room.name,
                "aria-describedby": room.unread === true ? unreadDescriptionId : undefined,
                title: room.name,
                onClick: () => open(`room:${room.id}`),
                children: [
                  /* @__PURE__ */ jsx_runtime.jsx("span", {
                    className: "copis-room-unread-slot",
                    "aria-hidden": "true",
                    children: room.unread === true && /* @__PURE__ */ jsx_runtime.jsx("span", {
                      className: "copis-room-unread-dot"
                    })
                  }),
                  /* @__PURE__ */ jsx_runtime.jsx("span", {
                    children: room.name
                  })
                ]
              }),
              Array.isArray(room.actions) && room.actions.length > 0 && /* @__PURE__ */ jsx_runtime.jsx(RoomActionMenu, {
                row: true,
                disabled: disabled || snapshot.epoch < 0,
                label: `管理「${room.name}」`,
                menuLabel: `${room.name}管理菜单`,
                items: room.actions.filter((a) => Object.hasOwn(ROOM_ACTION_LABELS, a)).map((a) => [a, ROOM_ACTION_LABELS[a], moreIcons[a]]),
                choose: (action) => directory(`manage:${snapshot.epoch}:${action}:${room.id}`)
              })
            ]
          }, `${snapshot.epoch}:${room.id}`)),
          snapshot.status === "error" ? /* @__PURE__ */ jsx_runtime.jsxs("button", {
            type: "button",
            className: "copis-menu-item",
            onClick: () => directory("refresh"),
            children: [
              /* @__PURE__ */ jsx_runtime.jsx(RotateCw, {}),
              "重试加载群列表"
            ]
          }) : !snapshot.rooms.length && /* @__PURE__ */ jsx_runtime.jsx("small", {
            children: snapshot.status === "signed-out" ? "登录后可查看共享群" : snapshot.status === "loading" ? "正在读取…" : "暂无共享群"
          })
        ]
      })
    ]
  });
}

// dsh-plugins/copis-creation-web/src/MediaPreview.tsx
var import_react4 = require("react");
var jsx_runtime2 = require("react/jsx-runtime");
function stopMedia(element) {
  if (!element?.hasAttribute("src"))
    return;
  element.pause();
  element.removeAttribute("src");
  element.load();
}
function MediaPreview({ resourceAddress, content, useResource, useTabInfo, bridge }) {
  const meta = useResource(resourceAddress);
  const { tab } = useTabInfo();
  const path = meta.value?.absolutePath;
  const version = meta.value?.version;
  const prepare = bridge?.prepareMediaPreview;
  const release = bridge?.releaseMediaPreview;
  const [state, setState] = import_react4.useState({ status: "loading" });
  const element = import_react4.useRef(null);
  const lease = import_react4.useRef(null);
  const reported = import_react4.useRef(false);
  const callbacks = import_react4.useRef(content);
  callbacks.current = content;
  const disposeRef = import_react4.useRef(() => {});
  const bindElement = import_react4.useCallback((node) => {
    if (element.current !== node)
      stopMedia(element.current);
    element.current = node;
  }, []);
  import_react4.useEffect(() => {
    setState({ status: "loading" });
    reported.current = false;
    disposeRef.current = () => {};
    if (!tab.visible || tab.signal.aborted)
      return;
    const fail = (error) => {
      setState({ status: "failed", error });
      callbacks.current.failed();
    };
    if (!prepare || !release) {
      fail("音视频预览需要在 Copis 桌面应用中打开");
      return;
    }
    if (!path) {
      if (meta.status !== "loading")
        fail("媒体文件不存在或无法定位");
      return;
    }
    let active = true;
    let url;
    const releaseUrl = (value) => {
      Promise.resolve().then(() => release(value)).catch(() => {});
    };
    const dispose = () => {
      if (!active)
        return;
      active = false;
      stopMedia(element.current);
      if (url) {
        if (lease.current?.url === url)
          lease.current = null;
        releaseUrl(url);
      }
    };
    disposeRef.current = dispose;
    tab.signal.addEventListener("abort", dispose, { once: true });
    Promise.resolve().then(() => prepare(path)).then((result) => {
      if (!active) {
        if (result.success)
          releaseUrl(result.url);
        return;
      }
      if (result.success === false) {
        fail(result.error);
        return;
      }
      url = result.url;
      lease.current = { url, version: version ?? String(content.revision) };
      setState({ status: "ready", media: result });
    }).catch(() => {
      if (active)
        fail("媒体文件读取失败，请重试");
    });
    return () => {
      tab.signal.removeEventListener("abort", dispose);
      dispose();
    };
  }, [resourceAddress, content.revision, path, version, meta.status, tab.visible, tab.signal, prepare, release]);
  import_react4.useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden)
        element.current?.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);
  if (!tab.visible)
    return null;
  const onLoadedMetadata = () => {
    if (state.status !== "ready" || lease.current?.url !== state.media.url || reported.current)
      return;
    reported.current = true;
    callbacks.current.loaded(lease.current.version);
  };
  const onError = () => {
    disposeRef.current();
    setState({ status: "failed", error: "无法播放此文件，文件可能已删除或媒体编码不受支持" });
    callbacks.current.failed();
  };
  return /* @__PURE__ */ jsx_runtime2.jsxs("div", {
    "data-copis-media-preview": true,
    style: { padding: 16, display: "flex", flexDirection: "column", gap: 12, width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", whiteSpace: "normal", boxSizing: "border-box", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)" },
    children: [
      state.status === "loading" && /* @__PURE__ */ jsx_runtime2.jsx("p", {
        role: "status",
        children: "正在加载媒体…"
      }),
      state.status === "failed" && /* @__PURE__ */ jsx_runtime2.jsxs(jsx_runtime2.Fragment, {
        children: [
          /* @__PURE__ */ jsx_runtime2.jsx("p", {
            role: "alert",
            children: state.error
          }),
          /* @__PURE__ */ jsx_runtime2.jsx("button", {
            type: "button",
            onClick: () => callbacks.current.reload(),
            children: "重试"
          })
        ]
      }),
      state.status === "ready" && (state.media.kind === "video" ? /* @__PURE__ */ jsx_runtime2.jsx("video", {
        ref: bindElement,
        src: state.media.url,
        controls: true,
        playsInline: true,
        preload: "metadata",
        "aria-label": "MP4 视频预览",
        onLoadedMetadata,
        onError,
        style: { flex: "1 1 0", width: "100%", height: "100%", minWidth: 0, minHeight: 0, objectFit: "contain", background: "#000", borderRadius: 8 }
      }, state.media.url) : /* @__PURE__ */ jsx_runtime2.jsx("audio", {
        ref: bindElement,
        src: state.media.url,
        controls: true,
        preload: "metadata",
        "aria-label": "MP3 音频预览",
        onLoadedMetadata,
        onError,
        style: { width: "100%", minWidth: 0, flexShrink: 0 }
      }, state.media.url))
    ]
  });
}
function registerMediaPreview(ctx, getBridge) {
  const id = "@copis-ext/creation-web/media";
  ctx.effect(() => ctx.documentPreviews.register({ id, extensions: ["mp4", "mp3"], binaryExtensions: ["mp4", "mp3"], priority: "extension", title: () => "音视频", loading: "renderer" }));
  ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({ name: "sidebar.right.tab.document", key: id }, (props) => /* @__PURE__ */ jsx_runtime2.jsx(MediaPreview, {
    ...props,
    bridge: getBridge()
  }))));
}

// dsh-plugins/copis-creation-web/src/session-completion.ts
function registerSessionCompletion(ctx, getBridge, host = {
  events: window,
  hasFocus: () => document.hasFocus(),
  isConversationVisible: () => !document.hidden && !document.body?.classList.contains("copis-subview-active")
}) {
  ctx.effect(() => {
    const controller = new AbortController;
    const previous = new Map;
    const generations = new Map;
    const delivered = new Map;
    let generationCounter = 0;
    const isViewed = (id) => host.hasFocus() && host.isConversationVisible() && ctx.sidebarRight.mounted.getSnapshot() === id;
    const acknowledge = () => {
      const id = ctx.sidebarRight.mounted.getSnapshot();
      if (id && isViewed(id))
        getBridge()?.reportSessionViewed?.(id);
    };
    const inspect = async (id, generation) => {
      try {
        const history = await ctx.remote.session.events({ address: { kind: "session", sessionId: id }, maxMessages: 1 }, controller.signal);
        if (!history.ok)
          return;
        const end = history.value.records.findLast(({ event }) => event.type === "turn/end")?.event;
        if (!end || end.data.reason?.kind !== "completed" || end.seq <= (delivered.get(id) ?? -1))
          return;
        const state = await ctx.remote.session.state({ sessionId: id }, controller.signal);
        const row = ctx.sessions.list.getSnapshot().byId?.[id];
        if (controller.signal.aborted || generations.get(id) !== generation || !row || row.running || !state.ok || state.value.running || state.value.queue?.length || state.value.pendingInput.length || row.projectionValues?.goal && row.projectionValues.goal.goal.phase !== "complete")
          return;
        delivered.set(id, end.seq);
        getBridge()?.reportSessionCompleted?.({
          sessionId: id,
          title: row.title || row.displayTitle || "创造模式会话",
          completionSeq: end.seq,
          viewed: isViewed(id),
          windowFocused: host.hasFocus()
        });
      } catch {
        if (!controller.signal.aborted)
          console.warn("[创造模式通知] 无法确认会话完成状态，已跳过本次提醒");
      }
    };
    const observe = () => {
      const snapshot = ctx.sessions.list.getSnapshot();
      if (snapshot.phase && snapshot.phase !== "ready") {
        previous.clear();
        generations.clear();
        return;
      }
      const ids = new Set(snapshot.ids ?? Object.keys(snapshot.byId ?? {}));
      for (const id of previous.keys()) {
        if (!ids.has(id)) {
          previous.delete(id);
          generations.delete(id);
          delivered.delete(id);
          getBridge()?.reportSessionViewed?.(id);
        }
      }
      for (const id of ids) {
        const row = snapshot.byId?.[id];
        if (!row || row.parentId || row.origin === "subagent")
          continue;
        const wasRunning = previous.get(id);
        previous.set(id, row.running);
        if (wasRunning !== row.running)
          generations.set(id, ++generationCounter);
        if (wasRunning && !row.running)
          inspect(id, generations.get(id));
      }
    };
    const onMessage = (event) => {
      const data = event.data;
      if (data?.type === "COPIS_DSH_OPEN_SESSION" && typeof data.sessionId === "string" && ctx.sessions.list.getSnapshot().byId?.[data.sessionId]) {
        ctx.uiWorkspace.openSession(data.sessionId);
        getBridge()?.navigate?.("conversations");
      }
      acknowledge();
    };
    const stopList = ctx.sessions.list.subscribe(observe);
    const stopMounted = ctx.sidebarRight.mounted.subscribe(acknowledge);
    host.events.addEventListener("focus", acknowledge);
    host.events.addEventListener("message", onMessage);
    observe();
    acknowledge();
    return () => {
      controller.abort();
      stopList();
      stopMounted();
      host.events.removeEventListener("focus", acknowledge);
      host.events.removeEventListener("message", onMessage);
    };
  });
}

// dsh-plugins/copis-creation-web/src/client.tsx
var jsx_runtime3 = require("react/jsx-runtime");
var CREATION_STYLES_ID = "copis-creation-web-styles";
var { atom, useAtom } = require_jotai();
var menuExpandedAtom = atom(false);
var pinnedMenuIdsAtom = atom(DEFAULT_DSH_PINNED_MENU_IDS);
var WORKSPACE_GROUP_CHAT = { id: "group-chat", label: "群聊协作", icon: UsersRound, view: "group-chat" };
var SIDEBAR_MENU_ITEMS = [
  { id: "search", label: "搜索", icon: Search, action: "search" },
  { id: "schedule", label: "日程表", icon: CalendarClock, view: "planning", tab: "schedule" },
  { id: "automations", label: "定时任务", icon: Timer, view: "automations" },
  { id: "memory", label: "记忆", icon: Brain, view: "memory" },
  { id: "knowledge", label: "知识库", icon: BookOpen, view: "knowledge" },
  { id: "expert-team", label: "专家团队", icon: UsersRound, view: "expert-team" },
  { id: "agent-skills", label: "技能市场", icon: Puzzle, view: "agent-skills" },
  { id: "fund-stock", label: "我的投资", icon: TrendingUp, view: "fund-stock" }
];
var CREATION_UI_CSS = `
  [class*="_logoRow"],
  [class*="logoRow"],
  [class*="_localBuildBrand"],
  [class*="localBuildBrand"] {
    display: none !important;
  }

  /* 侧边栏容器背景：对齐 Agent 模式 (hsl(var(--muted))) */
  .copis-creation-sidebar,
  .hHd-Xa_root,
  [class*="SidebarRoot_root"],
  [class*="SidebarRoot"],
  [class*="_sidebarCol"],
  [class*="sidebarCol"],
  aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 96.1%)) !important;
  }
  body[data-ds-dark-theme] .copis-creation-sidebar,
  body[data-ds-dark-theme] .hHd-Xa_root,
  body[data-ds-dark-theme] [class*="SidebarRoot_root"],
  body[data-ds-dark-theme] [class*="SidebarRoot"],
  body[data-ds-dark-theme] [class*="_sidebarCol"],
  body[data-ds-dark-theme] [class*="sidebarCol"],
  body[data-ds-dark-theme] aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 17%)) !important;
  }

  /* 隐藏 DSH 原生侧栏中遗留的旧版静态菜单（无 data-copis-placement），只保留 copis-creation-web 插件动态挂载的导航菜单 */
  .copis-menu-section:not([data-copis-placement="before-workspaces"]),
  .copis-rail-menu-section:not([data-copis-placement="before-workspaces"]) {
    display: none !important;
  }

  .copis-room-section { width: 100%; min-width: 0; margin: 8px 0; }
  .copis-room-heading { display:flex; align-items:center; gap:2px; }
  .copis-room-toggle { flex:1; flex-flow:row nowrap; min-width:0; font-weight:600; }
  .copis-room-action { anchor-name:var(--copis-room-anchor); display:grid; place-items:center; width:26px; height:26px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,currentColor); cursor:pointer; }
  .copis-room-action:disabled { opacity:.5; cursor:default; }
  .copis-room-action svg { width:15px; height:15px; }
  .copis-room-action-menu {
    position:fixed; position-anchor:var(--copis-room-anchor); inset:auto; top:anchor(bottom); right:anchor(right);
    position-try-fallbacks:flip-block; margin:5px 0; width:158px; padding:4px; box-sizing:border-box;
    color:var(--dsw-alias-label-primary,#242832);
    border:1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius:9px; box-shadow:0 6px 18px #0002;
  }
  body[data-ds-dark-theme] .copis-room-action-menu { color:var(--dsw-alias-label-primary,#e6eaf0); }
  .copis-room-action-menu button { display:flex; align-items:center; gap:10px; width:100%; padding:9px 10px; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; font-size:13px; cursor:pointer; }
  .copis-room-action-menu button:is(:hover,:focus-visible) { color:var(--creation-ui-primary); background:var(--creation-ui-primary-background); }
  .copis-room-action-menu svg { width:15px; height:15px; }
  .copis-room-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .copis-menu-item > .copis-room-unread-slot { display:flex; flex:0 0 8px; width:8px; height:8px; align-items:center; justify-content:center; }
  .copis-room-unread-dot { display:block; flex:0 0 7px; width:7px; height:7px; border-radius:50%; background:#ef4444; }
  .copis-workspace-group-entry { position:relative; }
  .copis-workspace-group-entry > .copis-room-unread-dot { position:absolute; top:3px; right:3px; }
  .copis-room-children { margin-block-start:6px; padding-inline-start:16px; min-width:0; }
  .copis-room-row { display:grid; grid-template-columns:minmax(0,1fr) 26px; align-items:center; border-radius:7px; }
  .copis-room-row > .copis-menu-item span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .copis-room-more { opacity:0; pointer-events:none; }
  .copis-room-row:is(:hover,:focus-within) .copis-room-more, .copis-room-more[aria-expanded="true"] { opacity:1; pointer-events:auto; }
  @media (hover:none) { .copis-room-more { opacity:1; pointer-events:auto; } }
  .copis-room-children small { display:block; padding:4px 8px; color:var(--dsw-alias-label-secondary,currentColor); }
  .copis-workspace-group-entry { margin: 8px 0; }
  .copis-workspace-group-entry.copis-rail-menu-item { margin-inline: auto; }

  .copis-menu-section {
    box-sizing: border-box;
    display: grid;
    flex: none;
    gap: 0;
    width: 100%;
    margin: 0 0 8px;
    padding: 0 2px;
  }

  .copis-menu-heading,
  .copis-menu-item {
    font-size: 14px;
  }

  .copis-menu-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 3px;
    color: var(--dsw-alias-label-secondary, #71717a);
    font-weight: 600;
  }

  .copis-menu-section > .copis-menu-row,
  .copis-menu-section > .copis-menu-toggle {
    margin-inline-start: 16px;
    width: calc(100% - 16px);
  }

  .copis-menu-section .copis-menu-toggle {
    min-height: 26px;
    color: var(--dsw-alias-label-secondary, #71717a);
    font-size: 12px;
  }

  .copis-settings-entry { margin-top: 5px; }

  .copis-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 31px;
    padding: 5px 8px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    font-weight: 400;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
    user-select: none;
  }

  .copis-menu-row:hover > .copis-menu-item,
  .copis-menu-row:focus-within > .copis-menu-item,
  .copis-menu-item:hover:where(:not(.copis-room-toggle)),
  .copis-menu-item:focus-visible,
  .copis-menu-item[data-active="true"],
  .copis-rail-menu-item:hover:where(:not(.copis-workspace-group-entry)),
  .copis-rail-menu-item:focus-visible,
  .copis-rail-menu-item[data-active="true"] {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15));
    color: var(--creation-ui-primary, #6c00cc);
  }

  .copis-menu-item[data-active="true"] {
    font-weight: 600;
  }

  /* 群行只在父容器绘制一次底色，群名与更多按钮仍是两个独立点击区。 */
  .copis-room-heading .copis-room-toggle:focus-visible,
  .copis-room-heading .copis-room-action:enabled:is(:hover,:focus-visible,[aria-expanded="true"]),
  .copis-rail-menu-item.copis-workspace-group-entry:is(:focus-visible,[data-active="true"]),
  .copis-room-row:is(:hover,:focus-within,:has(.copis-room-more[aria-expanded="true"])) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1));
    color: var(--dsw-alias-label-primary, currentColor);
  }
  .copis-room-row > .copis-menu-item {
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
  }
  .copis-room-row > .copis-menu-item[data-active="true"] { font-weight:500; }

  .copis-menu-heading svg,
  .copis-menu-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: var(--dsw-alias-label-secondary, #90939e);
  }

  .copis-menu-item[data-active="true"] svg {
    color: #ffffff !important;
  }

  .copis-menu-item > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copis-menu-row {
    position: relative;
    min-width: 0;
  }

  .copis-menu-pin-btn {
    position: absolute;
    inset-inline-end: 8px;
    top: 50%;
    transform: translateY(-50%);
    height: 20px;
    padding: 0 7px;
    border: 1px solid currentColor;
    border-radius: 9999px;
    background: transparent;
    color: var(--creation-ui-primary, #6c00cc);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
  }

  .copis-menu-row:is(:hover, :focus-within) > .copis-menu-pin-btn {
    opacity: 1;
    pointer-events: auto;
  }

  .copis-menu-row:is(:hover, :focus-within) > .copis-menu-item {
    padding-inline-end: 76px !important;
  }

  .copis-menu-pin-btn:is(:hover, :focus-visible) {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15));
  }

  .copis-menu-pin-btn:disabled {
    cursor: default;
  }

  .copis-rail-menu-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin-bottom: 8px;
  }

  .copis-rail-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, #71717a);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-rail-menu-item svg {
    width: 16px;
    height: 16px;
  }

  button[class*="_newSession"],
  button[class*="newSession"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: #f1f5f9 !important;
    transition: all 120ms ease !important;
  }
  button[class*="_newSession"]:hover,
  button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    border-color: rgba(255, 255, 255, 0.14) !important;
  }

  [class*="sessionRow"],
  [class*="SessionRow"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    transition: all 120ms ease !important;
  }
  [class*="sessionRow"]:hover,
  [class*="SessionRow"]:hover {
    background: rgba(255, 255, 255, 0.04) !important;
  }
  /* WorkBuddy 浅灰/曜石微高光卡片会话行选中态，彻底去除紫色 */
  .copis-room-row:has(> .copis-menu-item[data-active="true"]),
  .YDXeBa_sessionRow.YDXeBa_selected,
  .YDXeBa_searchResultRow.YDXeBa_selected,
  .YDXeBa_projectRow.active,
  [class*="sessionRow"][class*="selected"],
  [class*="searchResultRow"][class*="selected"],
  [class*="projectRow"][class*="active"],
  [class*="sessionRow"][data-selected="true"],
  [class*="SessionRow"][data-selected="true"] {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1)) !important;
    color: var(--dsw-alias-label-primary, #ffffff) !important;
    font-weight: 500 !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected *,
  [class*="sessionRow"][class*="selected"] * {
    color: var(--dsw-alias-label-primary, #ffffff) !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected [class*="date"],
  .YDXeBa_sessionRow.YDXeBa_selected [class*="time"],
  [class*="sessionRow"][class*="selected"] [class*="date"],
  [class*="sessionRow"][class*="selected"] [class*="time"],
  [class*="sessionRow"][class*="selected"] span:last-child {
    color: #a1a1aa !important;
  }
  .copis-room-row > .copis-menu-item[data-active="true"] svg,
  [class*="sessionRow"][class*="selected"] svg,
  [class*="searchResultRow"][class*="selected"] svg,
  [class*="projectRow"][class*="active"] svg {
    color: var(--dsw-alias-label-secondary, #d4d4d8) !important;
  }
  /* 侧栏工作区目录/项目图标：全部对齐 WorkBuddy 浅银灰色，绝不显示亮紫色 */
  .YDXeBa_projectRow svg,
  [class*="projectRow"] svg,
  [class*="workspaceRow"] svg {
    color: #a1a1aa !important;
  }

  /* WorkBuddy 风格顶部 Tab 导航（对话 / 轨迹）：纯净白色文字与白色指示条 */
  .wSkVaW_tab,
  [class*="wSkVaW_tab"],
  [class*="_tab"][role="tab"] {
    color: #94a3b8 !important;
    font-weight: 500 !important;
    transition: color 120ms ease !important;
  }
  .wSkVaW_tab:hover,
  [class*="wSkVaW_tab"]:hover,
  [class*="_tab"][role="tab"]:hover {
    color: #cbd5e1 !important;
  }
  .wSkVaW_tabActive,
  [class*="wSkVaW_tabActive"],
  [class*="_tabActive"],
  button[role="tab"][aria-selected="true"],
  [class*="tab"][class*="active"],
  [class*="tab"][data-active="true"] {
    color: #ffffff !important;
    font-weight: 600 !important;
  }
  .wSkVaW_tabActive:after,
  [class*="wSkVaW_tabActive"]:after,
  [class*="_tabActive"]:after,
  button[role="tab"][aria-selected="true"]:after,
  [class*="tab"][class*="active"]:after,
  [class*="tab"][data-active="true"]:after {
    background: #ffffff !important;
    height: 2px !important;
    border-radius: 1px !important;
  }

  /* WorkBuddy 菜单徽标样式：全灰阶轻量微胶囊 */
  .copis-menu-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex: none;
    line-height: 14px;
  }
  .copis-menu-badge-beta {
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border-color: rgba(255, 255, 255, 0.08);
  }
  .copis-menu-badge-flexible {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border-color: rgba(255, 255, 255, 0.06);
  }

  /* 优雅紫色半透明毛玻璃 Composer 输入胶囊卡片（背景更深，紫色更淡内敛） */
  [class*="uV2eYG_card"],
  [class*="_card"][class*="composer"] {
    border-radius: 20px !important;
    background: color-mix(in srgb, var(--creation-ui-primary, #a855f7) 7%, rgba(16, 17, 24, 0.90)) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    backdrop-filter: blur(24px) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #a855f7) 12%, rgba(255, 255, 255, 0.08)) !important;
    box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.6), 0 0 20px -4px color-mix(in srgb, var(--creation-ui-primary, #a855f7) 8%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    margin-bottom: 16px !important;
    padding-top: 10px !important;
  }

  body:not([data-ds-dark-theme]) [class*="uV2eYG_card"],
  body:not([data-ds-dark-theme]) [class*="_card"][class*="composer"] {
    background: color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 4%, rgba(255, 255, 255, 0.88)) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 10%, rgba(0, 0, 0, 0.08)) !important;
    box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8) !important;
  }

  [class*="uV2eYG_input"] {
    color: #f1f5f9 !important;
    font-size: 13.5px !important;
    line-height: 22px !important;
  }

  [class*="uV2eYG_placeholder"] {
    color: #64748b !important;
    font-size: 13.5px !important;
  }

  [class*="uV2eYG_add"] {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #cbd5e1 !important;
  }

  [class*="uV2eYG_add"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    color: #ffffff !important;
  }

  [class*="uV2eYG_select"] {
    background-color: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #e2e8f0 !important;
    font-size: 12px !important;
    padding: 0 20px 0 10px !important;
  }

  [class*="uV2eYG_select"]:hover {
    background-color: rgba(255, 255, 255, 0.09) !important;
  }

  /* WorkBuddy 浅曜石灰极简发送按钮，彻底消除红色与亮紫色 */
  [class*="uV2eYG_primary"],
  button[class*="uV2eYG_primary"],
  [class*="composer"] button[type="submit"] {
    border-radius: 9999px !important;
    background: #3f414a !important; /* fallback token: var(--ui-primary) */
    color: #f1f5f9 !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25) !important;
    transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease !important;
  }

  [class*="uV2eYG_primary"]:hover:not(:disabled),
  button[class*="uV2eYG_primary"]:hover:not(:disabled),
  [class*="composer"] button[type="submit"]:hover:not(:disabled) {
    background: #4d505a !important;
    border-color: rgba(255, 255, 255, 0.24) !important;
    color: #ffffff !important;
    transform: scale(1.05) !important;
  }

  [class*="uV2eYG_primary"]:disabled,
  button[class*="uV2eYG_primary"]:disabled,
  [class*="composer"] button[type="submit"]:disabled {
    background: rgba(255, 255, 255, 0.06) !important;
    color: rgba(255, 255, 255, 0.25) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    transform: none !important;
  }

  [class*="uV2eYG_root"]::after {
    content: "内容由 AI 生成，请核实重要信息";
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: rgba(148, 163, 184, 0.6);
    text-align: center;
    user-select: none;
  }

  /* 页面视口与对话容器：彻底消除横向多余滚动条与 hover 闪烁 */
  html,
  body,
  [class*="_centerCol"],
  [class*="centerCol"],
  [class*="_frame"],
  [class*="frame"],
  [data-view="conversation"],
  main,
  [class*="uV2eYG_root"] {
    overflow-x: clip !important;
    max-width: 100% !important;
  }

  /* 强制屏蔽页面与卡片底部的横向多余滚动条 */
  html::-webkit-scrollbar:horizontal,
  body::-webkit-scrollbar:horizontal,
  [class*="_centerCol"]::-webkit-scrollbar:horizontal,
  [class*="centerCol"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_root"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_card"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_row"]::-webkit-scrollbar:horizontal {
    display: none !important;
    height: 0 !important;
    width: 0 !important;
  }

  /* 上下文用量圆环（ContextMeter）与底部工具按钮悬浮 Tooltip 定位边界防溢出保护 */
  [class*="JObwrW_root"] {
    overflow: visible !important;
  }

  [class*="JObwrW_root"] [role="tooltip"],
  [class*="JObwrW_root"] [class*="tooltip"],
  [class*="JObwrW_root"] [class*="Tooltip"] {
    right: 0 !important;
    left: auto !important;
    max-width: 240px !important;
    white-space: nowrap !important;
    pointer-events: none !important;
  }

  /* 全局 Tooltip 浮层尺寸保护：避免绝对定位或动画帧撑大视口底部 */
  [role="tooltip"],
  [class*="tooltip"],
  [class*="Tooltip"] {
    max-width: calc(100vw - 32px) !important;
    word-break: break-word !important;
    pointer-events: none !important;
  }

  /* 当 Copis 子视图（规划/记忆/知识库/专家团队等）激活时：
     1. 彻底隐藏 DSH 原生中间对话区、欢迎屏、输入区与右侧详情栏；
     2. 强制 DSH 外层 Frame 与侧边栏独占整个 WebContentsView 视口 (100%)；
     3. 强制 DSH 侧边栏保持展开宽态 (Wide)，严禁误折叠为窄 Rail。 */
  body.copis-subview-active [class*="_centerCol"],
  body.copis-subview-active [class*="centerCol"],
  body.copis-subview-active [class*="_detailsCol"],
  body.copis-subview-active [class*="detailsCol"],
  body.copis-subview-active [class*="_handle"],
  body.copis-subview-active [class*="handle"],
  body.copis-subview-active [data-view="conversation"],
  body.copis-subview-active main {
    display: none !important;
    width: 0 !important;
    min-width: 0 !important;
    max-width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }

  body.copis-subview-active [class*="_frame"],
  body.copis-subview-active [class*="frame"] {
    display: flex !important;
    grid-template-columns: 100% !important;
    width: 100% !important;
    height: 100% !important;
  }

  body.copis-subview-active [class*="_sidebarCol"],
  body.copis-subview-active [class*="sidebarCol"] {
    display: flex !important;
    flex: 1 1 100% !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    border-right: none !important;
  }

  /* RC2 侧栏根节点为 div，覆盖原生抽屉保留的 48px 宽度差。 */
  body.copis-subview-active :is(.copis-creation-sidebar, .hHd-Xa_root, [class*="SidebarRoot_root"]) {
    box-sizing: border-box;
    width: 100% !important;
    padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
  }

  /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮（WorkBuddy 浅灰质感） */
  body.copis-subview-active button[class*="_newSession"],
  body.copis-subview-active button[class*="newSession"] {
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
    height: 36px !important;
    margin: 0 0 12px !important;
    padding: 0 12px !important;
    gap: 8px !important;
    background: rgba(255, 255, 255, 0.08) !important; /* fallback token: var(--creation-ui-primary-background) */
    color: #ffffff !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    border-radius: 7px !important;
    align-self: stretch !important;
    cursor: pointer !important;
    transition: background-color 150ms ease, border-color 150ms ease !important;
    box-sizing: border-box !important;
  }

  body.copis-subview-active button[class*="_newSession"]:hover,
  body.copis-subview-active button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    border-color: rgba(255, 255, 255, 0.22) !important;
  }

  /* 隐藏原「新建会话」图标 */
  body.copis-subview-active button[class*="_newSession"] svg,
  body.copis-subview-active button[class*="newSession"] svg {
    display: none !important;
  }

  /* 注入返回会话矢量箭头图标（仅作用于外层 button 前缀） */
  body.copis-subview-active button[class*="_newSession"]::before,
  body.copis-subview-active button[class*="newSession"]::before {
    content: "" !important;
    display: inline-block !important;
    width: 15px !important;
    height: 15px !important;
    flex: none !important;
    background-color: currentColor !important;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
  }

  /* 隐藏原「新会话」文字，替换为「返回会话」，确保内部 label 绝不带多余边框、背景或伪类箭头 */
  body.copis-subview-active [class*="newSessionLabel"],
  body.copis-subview-active [class*="_newSessionLabel"] {
    font-size: 0 !important;
    max-width: none !important;
    opacity: 1 !important;
    display: inline-flex !important;
    align-items: center !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
    height: auto !important;
    color: currentColor !important;
    box-shadow: none !important;
  }

  body.copis-subview-active [class*="newSessionLabel"]::before,
  body.copis-subview-active [class*="_newSessionLabel"]::before {
    content: none !important;
    display: none !important;
  }

  /* 只在文字节点生成标签，避免 RC2 的 LabelMask 再生成一次。 */
  body.copis-subview-active [class*="newSessionLabel"]:not([class*="newSessionLabelMask"])::after {
    content: "返回会话" !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    line-height: 20px !important;
    color: currentColor !important;
    white-space: nowrap !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
  }

  /* 在按钮最右侧展示精致的 Esc 快捷键胶囊（仅作用于外层 button 自身） */
  body.copis-subview-active button[class*="_newSession"]::after,
  body.copis-subview-active button[class*="newSession"]::after {
    content: "Esc" !important;
    margin-left: auto !important;
    font-size: 10px !important;
    font-weight: 500 !important;
    font-family: ui-monospace, monospace !important;
    line-height: 1 !important;
    padding: 2px 5px !important;
    border-radius: 4px !important;
    border: 1px solid currentColor !important;
    opacity: 0.7 !important;
    background: transparent !important;
    color: currentColor !important;
    flex: none !important;
  }

  body.copis-subview-active [class*="_regionArea"],
  body.copis-subview-active [class*="regionArea"] {
    display: flex !important;
    flex-direction: column !important;
    margin-left: -4px !important;
    margin-right: calc(-1 * var(--dsh-sidebar-inline-padding, 12px)) !important;
    padding-left: 4px !important;
  }

  /* 确保侧边栏工作区顶栏未展开搜索时，搜索按钮与操作按钮完整呈现，防止被 flex 压缩或裁剪 */
  [class*="sectionHeader"] {
    display: flex !important;
    align-items: center !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) {
    display: flex !important;
    min-width: 28px !important;
    max-width: 28px !important;
    flex: 0 0 28px !important;
    margin-left: auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="search"] {
    display: flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="searchButton"] {
    display: inline-flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="headerActions"]:not([class*="headerActionsHidden"]):not([class*="_headerActionsHidden"]) {
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    min-width: 60px !important;
    max-width: none !important;
    flex: 0 0 auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }

  body.copis-subview-active .copis-menu-section {
    display: grid !important;
  }

  body.copis-subview-active [class*="_footArea"],
  body.copis-subview-active [class*="footArea"] {
    align-items: stretch !important;
  }

  /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
  button[class*="sessionLogButton"],
  button[title*="返回 Agent 模式"],
  button[title*="返回Agent 模式"],
  button[aria-label*="返回 Agent 模式"],
  button[aria-label*="返回Agent 模式"],
  [data-slot-id="session-log-download"] {
    display: none !important;
  }

  /* 搜索浮层全局遮罩与弹窗：保持底层 DSH 视图完全可见，绝不触发全黑全白 */
  .copis-search-modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
    animation: copis-search-modal-fade-in 140ms ease-out;
  }

  @keyframes copis-search-modal-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .copis-room-action-menu,
  .copis-search-modal-card {
    background: var(--dsw-alias-bg-base, #ffffff);
  }

  .copis-search-modal-card {
    width: 580px;
    max-width: calc(100vw - 32px);
    max-height: 520px;
    color: var(--dsw-alias-label-primary, #18181b);
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    animation: copis-search-modal-scale-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes copis-search-modal-scale-in {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .copis-search-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .copis-search-main-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--dsw-alias-label-primary, inherit);
    line-height: 20px;
  }

  .copis-search-main-input::placeholder {
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
  }

  .copis-search-submit-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-search-submit-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.22);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .copis-search-submit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .copis-search-results-list {
    max-height: 380px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .copis-search-item-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    cursor: pointer;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    color: inherit;
    font-family: inherit;
    transition: background-color 100ms ease;
  }

  .copis-search-item-row:hover,
  .copis-search-item-row[data-selected="true"] {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  .copis-search-badge-creation {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: #e4e4e7;
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-weight: 500;
    flex-shrink: 0;
  }

  .copis-search-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    font-size: 11px;
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
    background: var(--dsw-alias-bg-base, inherit);
    flex-shrink: 0;
  }
`;
function installCreationStyles() {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(CREATION_STYLES_ID))
    return;
  const style = document.createElement("style");
  style.id = CREATION_STYLES_ID;
  style.textContent = CREATION_UI_CSS;
  document.head.appendChild(style);
}
function sendNavigation(view, tab) {
  if (view && view !== "conversations") {
    document.body?.classList.add("copis-subview-active");
    document.documentElement?.classList.add("copis-subview-active");
  } else {
    document.body?.classList.remove("copis-subview-active");
    document.documentElement?.classList.remove("copis-subview-active");
  }
  if (view === "settings") {
    if (window.copisBridge?.openSettings) {
      window.copisBridge.openSettings();
      return;
    }
    window.postMessage({ type: "COPIS_OPEN_SETTINGS" }, "*");
    return;
  }
  if (window.copisBridge?.navigate) {
    window.copisBridge.navigate(view, tab);
    return;
  }
  window.postMessage({ type: "COPIS_NAVIGATE", view, tab }, "*");
}
function requestRoomDirectory(tab) {
  if (window.copisBridge?.navigate)
    window.copisBridge.navigate("group-chat", tab);
  else
    window.postMessage({ type: "COPIS_NAVIGATE", view: "group-chat", tab }, "*");
}
function sendSearchRequest() {
  window.dispatchEvent(new CustomEvent("COPIS_OPEN_SEARCH_MODAL"));
  if (window.copisBridge?.openSearch) {
    window.copisBridge.openSearch();
    return;
  }
  window.postMessage({ type: "COPIS_OPEN_SEARCH" }, "*");
}
function attachSidebarMenu(element) {
  const sidebar = element.closest('[class*="_root"]') ?? element.closest('[class*="SidebarRoot"]') ?? element.closest('[class*="_sidebarCol"], [class*="sidebarCol"]') ?? element.closest("aside");
  if (!sidebar)
    return null;
  sidebar.classList.add("copis-creation-sidebar");
  const legacySections = sidebar.querySelectorAll('.copis-menu-section:not([data-copis-placement="before-workspaces"]), .copis-rail-menu-section:not([data-copis-placement="before-workspaces"])');
  legacySections.forEach((el) => el.remove());
  const target = sidebar.querySelector('[class*="_regionArea"], [class*="regionArea"]') ?? sidebar.querySelector('button[class*="_newSession"], button[class*="newSession"]');
  if (!target?.parentElement)
    return null;
  const host = document.createElement("div");
  host.style.display = "contents";
  if (target.parentElement.matches('[class*="_scrollArea"]') && target.matches('[class*="regionArea"]')) {
    target.prepend(host);
  } else {
    target.before(host);
  }
  const afterWorkspaces = document.createElement("div");
  afterWorkspaces.dataset.copisPlacement = "after-workspaces";
  if (target.parentElement.matches('[class*="_scrollArea"]')) {
    afterWorkspaces.style.gridArea = "-1 / 2";
  }
  target.after(afterWorkspaces);
  return { before: host, after: afterWorkspaces };
}
var cachedCordisContext = null;
function CreationSidebarNavigation(props) {
  const [activeView, setActiveView] = import_react5.useState("conversations");
  const [expanded, setExpanded] = useAtom(menuExpandedAtom);
  const [pinnedMenuIds, setPinnedMenuIds] = useAtom(pinnedMenuIdsAtom);
  const [pinsReady, setPinsReady] = import_react5.useState(false);
  const [savingPins, setSavingPins] = import_react5.useState(false);
  const rootRef = import_react5.useRef(null);
  const [menuHost, setMenuHost] = import_react5.useState(null);
  const isSubviewActive = activeView !== "conversations";
  const effectiveCtx = props.ctx ?? cachedCordisContext;
  const wide = isSubviewActive || Boolean(props.wide) || !props.collapsed && (props.width === undefined || props.width >= 200);
  import_react5.useLayoutEffect(() => {
    const host = rootRef.current && attachSidebarMenu(rootRef.current);
    setMenuHost(host);
    return () => {
      host?.before.remove();
      host?.after.remove();
    };
  }, [props.collapsed, props.wide]);
  import_react5.useLayoutEffect(() => {
    if (isSubviewActive || !wide)
      return;
    const anchor = rootRef.current;
    const sidebar = anchor?.closest('[class*="_sidebarCol"]') ?? anchor?.closest(".copis-creation-sidebar");
    if (!sidebar)
      return;
    let lastWidth = 0;
    const reportWidth = () => {
      if (document.body.classList.contains("copis-subview-active") || sidebar.closest("[data-sidebar-drawer], [data-sidebar-collapsed]"))
        return;
      const width = Math.round(sidebar.getBoundingClientRect().width);
      if (width === lastWidth || !isDshExpandedSidebarWidth(width))
        return;
      lastWidth = width;
      window.copisBridge?.reportSidebarInfo?.({ width, wide: true });
    };
    const observer = typeof window.ResizeObserver !== "undefined" ? new window.ResizeObserver(reportWidth) : null;
    observer?.observe(sidebar);
    reportWidth();
    return () => observer?.disconnect();
  }, [isSubviewActive, wide, props.width]);
  import_react5.useEffect(() => {
    const layout = effectiveCtx?.layout;
    if (!isSubviewActive || !layout)
      return;
    const anchor = rootRef.current;
    const frame = anchor?.closest('[class*="_frame"], [data-sidebar-drawer]');
    let requested = false;
    const expandIfCollapsed = () => {
      const collapsed = frame ? frame.hasAttribute("data-sidebar-collapsed") : props.collapsed === true || Boolean(anchor?.closest(".hHd-Xa_collapsed"));
      if (!collapsed) {
        requested = false;
        return;
      }
      if (requested)
        return;
      requested = true;
      layout.toggleSidebar();
    };
    const observer = frame && typeof window.MutationObserver !== "undefined" ? new window.MutationObserver(expandIfCollapsed) : null;
    if (frame)
      observer?.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
    expandIfCollapsed();
    return () => observer?.disconnect();
  }, [isSubviewActive, props.collapsed, effectiveCtx]);
  import_react5.useEffect(() => {
    const handleTopButtonClick = (event) => {
      if (!isSubviewActive)
        return;
      const target = event.target;
      const topBtn = target?.closest('button[class*="_newSession"], button[class*="newSession"]');
      if (!topBtn)
        return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setActiveView("conversations");
      document.body?.classList.remove("copis-subview-active");
      document.documentElement?.classList.remove("copis-subview-active");
      sendNavigation("conversations");
    };
    document.addEventListener("click", handleTopButtonClick, true);
    return () => document.removeEventListener("click", handleTopButtonClick, true);
  }, [isSubviewActive]);
  import_react5.useEffect(() => {
    const topBtn = document.querySelector('button[class*="_newSession"], button[class*="newSession"]');
    if (!topBtn)
      return;
    if (isSubviewActive) {
      topBtn.setAttribute("data-copis-return-button", "true");
      topBtn.setAttribute("title", "返回会话 (Esc)");
      topBtn.setAttribute("aria-label", "返回会话 (Esc)");
    } else {
      topBtn.removeAttribute("data-copis-return-button");
      topBtn.setAttribute("title", "新建会话");
      topBtn.setAttribute("aria-label", "新建会话");
    }
  }, [isSubviewActive]);
  import_react5.useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.toLowerCase();
      if (path.includes("planning"))
        setActiveView("planning");
      else if (path.includes("automations"))
        setActiveView("automations");
      else if (path.includes("memory"))
        setActiveView("memory");
      else if (path.includes("knowledge"))
        setActiveView("knowledge");
      else if (path.includes("expert-team"))
        setActiveView("expert-team");
      else if (path.includes("agent-skills"))
        setActiveView("agent-skills");
      else if (path.includes("fund-stock"))
        setActiveView("fund-stock");
      else
        setActiveView("conversations");
    };
    handlePopState();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  import_react5.useEffect(() => {
    const handleActiveViewMessage = (event) => {
      if (event.data && typeof event.data === "object") {
        const d = event.data;
        if (d.type === "COPIS_ACTIVE_VIEW_CHANGE") {
          if (d.view === "conversations") {
            setActiveView("conversations");
            document.body?.classList.remove("copis-subview-active");
            document.documentElement?.classList.remove("copis-subview-active");
          } else if (d.view) {
            setActiveView(d.view);
            document.body?.classList.add("copis-subview-active");
            document.documentElement?.classList.add("copis-subview-active");
          }
        } else if (d.type === "COPIS_SUBVIEW_CHANGE") {
          if (!d.subview) {
            setActiveView("conversations");
            document.body?.classList.remove("copis-subview-active");
            document.documentElement?.classList.remove("copis-subview-active");
          } else {
            setActiveView(d.subview);
            document.body?.classList.add("copis-subview-active");
            document.documentElement?.classList.add("copis-subview-active");
          }
        }
      }
    };
    window.addEventListener("message", handleActiveViewMessage);
    return () => window.removeEventListener("message", handleActiveViewMessage);
  }, []);
  import_react5.useEffect(() => {
    const bridge = window.copisBridge;
    if (!bridge?.getPinnedMenuItems)
      return;
    let active = true;
    bridge.getPinnedMenuItems().then((ids) => {
      if (!active)
        return;
      setPinnedMenuIds(Array.isArray(ids) ? ids : DEFAULT_DSH_PINNED_MENU_IDS);
      setPinsReady(true);
    }).catch((err) => console.warn("[Copis 功能] 读取固定菜单失败:", err));
    return () => {
      active = false;
    };
  }, [setPinnedMenuIds]);
  const selectItem = (item) => {
    if (item.action === "search") {
      sendSearchRequest();
      return;
    }
    if (!item.view)
      return;
    setActiveView(item.view);
    document.body?.classList.add("copis-subview-active");
    document.documentElement?.classList.add("copis-subview-active");
    sendNavigation(item.view, item.tab);
  };
  const togglePin = async (menuId) => {
    const bridge = window.copisBridge;
    if (!pinsReady || savingPins || !bridge?.setPinnedMenuItems)
      return;
    const next = SIDEBAR_MENU_ITEMS.filter(({ id }) => id === menuId ? !pinnedMenuIds.includes(id) : pinnedMenuIds.includes(id)).map(({ id }) => id);
    setSavingPins(true);
    setPinnedMenuIds(next);
    try {
      await bridge.setPinnedMenuItems(next);
    } catch (err) {
      setPinnedMenuIds(pinnedMenuIds);
      console.warn("[Copis 功能] 保存固定菜单失败:", err);
    } finally {
      setSavingPins(false);
    }
  };
  const pinned = SIDEBAR_MENU_ITEMS.filter(({ id }) => pinnedMenuIds.includes(id));
  const unpinned = SIDEBAR_MENU_ITEMS.filter(({ id }) => !pinnedMenuIds.includes(id));
  const itemClass = wide ? "copis-menu-item" : "copis-rail-menu-item";
  const ToggleIcon = expanded ? ChevronUp : ChevronDown;
  const toggleLabel = expanded ? "收起" : "展开显示";
  const renderMenuItem = (item, isPinned) => {
    const Icon2 = item.icon;
    const action = isPinned ? "取消固定" : "固定显示";
    const button = /* @__PURE__ */ jsx_runtime3.jsxs("button", {
      type: "button",
      className: itemClass,
      "data-copis-menu-id": item.id,
      "data-active": item.view === activeView ? "true" : "false",
      "aria-label": item.label,
      title: wide ? undefined : item.label,
      onClick: () => selectItem(item),
      children: [
        /* @__PURE__ */ jsx_runtime3.jsx(Icon2, {
          size: wide ? 16 : 18,
          strokeWidth: 1.8,
          "aria-hidden": "true"
        }),
        wide && /* @__PURE__ */ jsx_runtime3.jsx("span", {
          children: item.label
        }),
        wide && item.badge && /* @__PURE__ */ jsx_runtime3.jsx("span", {
          className: `copis-menu-badge ${item.badge === "BETA" ? "copis-menu-badge-beta" : "copis-menu-badge-flexible"}`,
          children: item.badge
        })
      ]
    }, item.id);
    return wide ? /* @__PURE__ */ jsx_runtime3.jsxs("div", {
      className: "copis-menu-row",
      children: [
        button,
        /* @__PURE__ */ jsx_runtime3.jsx("button", {
          type: "button",
          className: "copis-menu-pin-btn",
          "aria-label": `${action}${item.label}`,
          title: action,
          disabled: !pinsReady || savingPins,
          onClick: () => void togglePin(item.id),
          children: action
        })
      ]
    }, item.id) : button;
  };
  const menu = /* @__PURE__ */ jsx_runtime3.jsxs("div", {
    className: wide ? "copis-menu-section" : "copis-rail-menu-section",
    "data-copis-placement": "before-workspaces",
    role: "group",
    "aria-label": "Copis功能",
    children: [
      wide && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
        className: "copis-menu-heading",
        children: [
          /* @__PURE__ */ jsx_runtime3.jsx(LayoutGrid, {
            size: 16,
            strokeWidth: 1.8,
            "aria-hidden": "true"
          }),
          /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: "Copis功能"
          })
        ]
      }),
      pinned.map((item) => renderMenuItem(item, true)),
      unpinned.length > 0 && /* @__PURE__ */ jsx_runtime3.jsxs("button", {
        type: "button",
        className: `${itemClass} copis-menu-toggle`,
        "aria-expanded": expanded,
        "aria-label": toggleLabel,
        title: wide ? undefined : toggleLabel,
        onClick: () => setExpanded(!expanded),
        children: [
          /* @__PURE__ */ jsx_runtime3.jsx(ToggleIcon, {
            size: 14
          }),
          wide && /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: toggleLabel
          })
        ]
      }),
      expanded && unpinned.map((item) => renderMenuItem(item, false)),
      /* @__PURE__ */ jsx_runtime3.jsxs("button", {
        type: "button",
        className: `${itemClass} copis-settings-entry`,
        "aria-label": "Copis 设置",
        title: wide ? undefined : "Copis 设置",
        onClick: () => sendNavigation("settings"),
        children: [
          /* @__PURE__ */ jsx_runtime3.jsx(Settings, {
            size: wide ? 16 : 18,
            strokeWidth: 1.8
          }),
          wide && /* @__PURE__ */ jsx_runtime3.jsx("span", {
            children: "Copis 设置"
          })
        ]
      })
    ]
  });
  const groupEntry = /* @__PURE__ */ jsx_runtime3.jsx(SharedRoomSection, {
    wide,
    active: activeView === "group-chat",
    directory: requestRoomDirectory,
    open: (tab) => selectItem({ ...WORKSPACE_GROUP_CHAT, tab })
  });
  return /* @__PURE__ */ jsx_runtime3.jsxs(jsx_runtime3.Fragment, {
    children: [
      /* @__PURE__ */ jsx_runtime3.jsx("span", {
        ref: rootRef,
        hidden: true
      }),
      menuHost ? import_react_dom.createPortal(menu, menuHost.before) : menu,
      menuHost ? import_react_dom.createPortal(groupEntry, menuHost.after) : groupEntry
    ]
  });
}
function HighlightSearchText({ text, query }) {
  if (!query || !query.trim())
    return /* @__PURE__ */ jsx_runtime3.jsx(jsx_runtime3.Fragment, {
      children: text
    });
  const trimmed = query.trim();
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const parts = [];
  let lastIndex = 0;
  let idx = lowerText.indexOf(lowerQuery);
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(/* @__PURE__ */ jsx_runtime3.jsx("span", {
        children: text.slice(lastIndex, idx)
      }, `t-${lastIndex}`));
    }
    parts.push(/* @__PURE__ */ jsx_runtime3.jsx("mark", {
      style: {
        background: "rgba(255, 255, 255, 0.18)",
        color: "#ffffff",
        borderRadius: 2,
        padding: "0 2px",
        fontWeight: 600
      },
      children: text.slice(idx, idx + trimmed.length)
    }, `m-${idx}`));
    lastIndex = idx + trimmed.length;
    idx = lowerText.indexOf(lowerQuery, lastIndex);
  }
  if (lastIndex < text.length) {
    parts.push(/* @__PURE__ */ jsx_runtime3.jsx("span", {
      children: text.slice(lastIndex)
    }, `end-${lastIndex}`));
  }
  return /* @__PURE__ */ jsx_runtime3.jsx(jsx_runtime3.Fragment, {
    children: parts
  });
}
function CopisSearchModal(props) {
  const [query, setQuery] = import_react5.useState("");
  const [committedQuery, setCommittedQuery] = import_react5.useState("");
  const [hasSearched, setHasSearched] = import_react5.useState(false);
  const [titleResults, setTitleResults] = import_react5.useState([]);
  const [selectedIndex, setSelectedIndex] = import_react5.useState(0);
  const inputRef = import_react5.useRef(null);
  const isComposingRef = import_react5.useRef(false);
  import_react5.useEffect(() => {
    if (props.open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } else {
      setQuery("");
      setCommittedQuery("");
      setTitleResults([]);
      setHasSearched(false);
      setSelectedIndex(0);
    }
  }, [props.open]);
  const runSearch = import_react5.useCallback(() => {
    const q = query.trim();
    if (!q) {
      setTitleResults([]);
      setHasSearched(false);
      setCommittedQuery("");
      return;
    }
    setCommittedQuery(q);
    setHasSearched(true);
    setSelectedIndex(0);
    const qLower = q.toLowerCase();
    const titles = [];
    try {
      const listSnapshot = props.ctx.sessions?.list?.getSnapshot();
      if (listSnapshot?.byId) {
        for (const [id, s] of Object.entries(listSnapshot.byId)) {
          const t = s?.title || "新会话";
          if (t.toLowerCase().includes(qLower)) {
            titles.push({
              id,
              title: t,
              updatedAt: s?.updatedAt || s?.createdAt || 0
            });
          }
        }
      }
    } catch (err) {
      console.warn("[CopisSearchModal] 读取 DSH 会话失败:", err);
    }
    titles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setTitleResults(titles);
  }, [query, props.ctx.sessions]);
  const navigateToResult = import_react5.useCallback((item) => {
    props.onClose();
    props.ctx.uiWorkspace.openSession(item.id);
  }, [props.ctx.uiWorkspace, props.onClose]);
  const handleKeyDown = import_react5.useCallback((e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => titleResults.length > 0 ? (prev + 1) % titleResults.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => titleResults.length > 0 ? (prev - 1 + titleResults.length) % titleResults.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isComposingRef.current)
        return;
      if (query.trim() !== committedQuery || !hasSearched) {
        runSearch();
      } else if (titleResults[selectedIndex]) {
        navigateToResult(titleResults[selectedIndex]);
      }
    }
  }, [titleResults, committedQuery, hasSearched, navigateToResult, props, query, runSearch, selectedIndex]);
  if (!props.open)
    return null;
  const isQueryDirty = query.trim() !== committedQuery;
  return /* @__PURE__ */ jsx_runtime3.jsx("div", {
    className: "copis-search-modal-backdrop",
    onClick: (e) => {
      if (e.target === e.currentTarget) {
        props.onClose();
      }
    },
    children: /* @__PURE__ */ jsx_runtime3.jsxs("div", {
      className: "copis-search-modal-card",
      onKeyDown: handleKeyDown,
      children: [
        /* @__PURE__ */ jsx_runtime3.jsxs("div", {
          className: "copis-search-input-row",
          children: [
            /* @__PURE__ */ jsx_runtime3.jsx(Search, {
              size: 16,
              style: { color: "var(--dsw-alias-label-tertiary, #a1a1aa)", flexShrink: 0 }
            }),
            /* @__PURE__ */ jsx_runtime3.jsx("input", {
              ref: inputRef,
              type: "text",
              className: "copis-search-main-input",
              value: query,
              placeholder: "输入关键词，按 Enter 或点击搜索",
              onChange: (e) => setQuery(e.target.value),
              onCompositionStart: () => {
                isComposingRef.current = true;
              },
              onCompositionEnd: () => {
                isComposingRef.current = false;
              }
            }),
            query && /* @__PURE__ */ jsx_runtime3.jsx("button", {
              type: "button",
              onClick: () => {
                setQuery("");
                setCommittedQuery("");
                setTitleResults([]);
                setHasSearched(false);
                setSelectedIndex(0);
                inputRef.current?.focus();
              },
              style: {
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--dsw-alias-label-tertiary, #a1a1aa)",
                padding: "2px",
                display: "inline-flex",
                alignItems: "center"
              },
              title: "清空",
              children: /* @__PURE__ */ jsx_runtime3.jsx(X, {
                size: 14
              })
            }),
            /* @__PURE__ */ jsx_runtime3.jsxs("button", {
              type: "button",
              className: "copis-search-submit-btn",
              disabled: !query.trim(),
              onClick: () => runSearch(),
              children: [
                /* @__PURE__ */ jsx_runtime3.jsx(Search, {
                  size: 13
                }),
                /* @__PURE__ */ jsx_runtime3.jsx("span", {
                  children: "搜索"
                })
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime3.jsxs("div", {
          className: "copis-search-results-list",
          children: [
            !hasSearched && /* @__PURE__ */ jsx_runtime3.jsx("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: "输入关键词后按 Enter 或点击搜索开始查找"
            }),
            hasSearched && titleResults.length === 0 && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
              style: { padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #a1a1aa)" },
              children: [
                '未找到与 "',
                committedQuery,
                '" 匹配的会话标题'
              ]
            }),
            titleResults.length > 0 && /* @__PURE__ */ jsx_runtime3.jsxs("div", {
              children: [
                /* @__PURE__ */ jsx_runtime3.jsxs("div", {
                  style: { padding: "6px 14px 2px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #a1a1aa)", textTransform: "uppercase" },
                  children: [
                    "会话匹配 (",
                    titleResults.length,
                    ")"
                  ]
                }),
                titleResults.map((item, idx) => /* @__PURE__ */ jsx_runtime3.jsxs("button", {
                  type: "button",
                  className: "copis-search-item-row",
                  "data-selected": selectedIndex === idx ? "true" : "false",
                  onClick: () => navigateToResult(item),
                  onMouseEnter: () => setSelectedIndex(idx),
                  children: [
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      className: "copis-search-badge-creation",
                      children: "创造"
                    }),
                    /* @__PURE__ */ jsx_runtime3.jsx("span", {
                      style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 500 },
                      children: /* @__PURE__ */ jsx_runtime3.jsx(HighlightSearchText, {
                        text: item.title,
                        query: committedQuery
                      })
                    })
                  ]
                }, `title-${item.id}-${idx}`))
              ]
            })
          ]
        }),
        /* @__PURE__ */ jsx_runtime3.jsxs("div", {
          className: "copis-search-footer",
          children: [
            /* @__PURE__ */ jsx_runtime3.jsxs("span", {
              children: [
                "↵ ",
                isQueryDirty || !hasSearched ? "搜索" : "打开"
              ]
            }),
            /* @__PURE__ */ jsx_runtime3.jsx("span", {
              children: "↑↓ 选择"
            }),
            /* @__PURE__ */ jsx_runtime3.jsx("span", {
              children: "Esc 关闭"
            })
          ]
        })
      ]
    })
  });
}
function CopisShellOverlayManager(props) {
  const [searchOpen, setSearchOpen] = import_react5.useState(false);
  import_react5.useEffect(() => {
    const handleOpenSearch = () => setSearchOpen(true);
    const handleMessage = (event) => {
      if (event.source && event.source !== window)
        return;
      const type = event.data?.type;
      if (type === "COPIS_DSH_NEW_SESSION") {
        const id = event.data.requestId;
        if (typeof id !== "string" || !id || id.length > 128)
          return;
        const key = "copis.dsh.lastNewSessionRequest";
        if (window.sessionStorage.getItem(key) !== id) {
          setSearchOpen(false);
          props.ctx.uiWorkspace.startSession();
          window.sessionStorage.setItem(key, id);
        }
        window.copisBridge?.navigate?.("conversations", `dsh-session-accepted:${id}`);
      } else if (type === "COPIS_OPEN_SEARCH_MODAL" || type === "COPIS_OPEN_SEARCH") {
        setSearchOpen(true);
      }
    };
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("COPIS_OPEN_SEARCH_MODAL", handleOpenSearch);
    window.addEventListener("message", handleMessage);
    window.addEventListener("keydown", handleKeyDown);
    window.copisBridge?.navigate?.("conversations", "dsh-client-ready");
    return () => {
      window.removeEventListener("COPIS_OPEN_SEARCH_MODAL", handleOpenSearch);
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.ctx.uiWorkspace]);
  return searchOpen ? /* @__PURE__ */ jsx_runtime3.jsx(CopisSearchModal, {
    open: true,
    onClose: () => setSearchOpen(false),
    ctx: props.ctx
  }) : null;
}
var inject = ["slots", "layout", "sessions", "workspaces", "documentPreviews", "remote.session", "sidebarRight", "uiWorkspace"];
function apply(ctx) {
  cachedCordisContext = ctx;
  console.log("[Copis Creation Web] 客户端插件正在激活...", ctx);
  installCreationStyles();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "copis-creation-sidebar", order: -100 }, (props) => /* @__PURE__ */ jsx_runtime3.jsx(CreationSidebarNavigation, {
    ...props,
    ctx
  })));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "copis-shell-overlay-manager",
    order: 100
  }, () => /* @__PURE__ */ jsx_runtime3.jsx(CopisShellOverlayManager, {
    ctx
  })));
  registerMediaPreview(ctx, () => window.copisBridge);
  registerSessionCompletion(ctx, () => window.copisBridge);
  console.log("[Copis Creation Web] 客户端插件插槽注入完成");
}

    exports.apply = typeof apply !== "undefined" ? apply : undefined;
    exports.inject = typeof inject !== "undefined" ? inject : undefined;
    exports.default = { apply: exports.apply, inject: exports.inject };
    return module.exports;
  }
});
