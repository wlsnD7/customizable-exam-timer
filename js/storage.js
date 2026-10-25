// Keeps the logo and custom audio files in IndexedDB, which can hold far more
// than localStorage. Falls back to memory when IndexedDB is unavailable.
window.MediaStore = (function () {
  'use strict';

  var DB_NAME = 'customizable-exam-timer';
  var STORE = 'media';
  var memory = new Map();
  var dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        try {
          var req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        } catch (err) {
          reject(err);
        }
      });
    }
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  return {
    get: function (key) {
      return run('readonly', function (s) { return s.get(key); })
        .then(function (v) { return v || null; })
        .catch(function () { return memory.get(key) || null; });
    },
    set: function (key, value) {
      memory.set(key, value);
      return run('readwrite', function (s) { return s.put(value, key); }).catch(function () {});
    },
    remove: function (key) {
      memory.delete(key);
      return run('readwrite', function (s) { return s.delete(key); }).catch(function () {});
    },
    clear: function () {
      memory.clear();
      return run('readwrite', function (s) { return s.clear(); }).catch(function () {});
    }
  };
})();
