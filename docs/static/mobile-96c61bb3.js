/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("app$1.0.0", "marko", "4.16.3");
$_mod.remap("/marko$4.16.3/components", "/marko$4.16.3/components-browser.marko");
$_mod.main("/marko$4.16.3/dist/components", "");
$_mod.remap("/marko$4.16.3/dist/components/index", "/marko$4.16.3/dist/components/index-browser");
$_mod.remap("/marko$4.16.3/dist/components/util", "/marko$4.16.3/dist/components/util-browser");
$_mod.def("/marko$4.16.3/dist/components/dom-data", function(require, exports, module, __filename, __dirname) { var counter = 0;
var seed = require.resolve('/marko$4.16.3/dist/components/dom-data'/*"./dom-data"*/);
var WeakMap = global.WeakMap || function WeakMap() {
    var id = seed + counter++;
    return {
        get: function (ref) {
            return ref[id];
        },
        set: function (ref, value) {
            ref[id] = value;
        }
    };
};

module.exports = {
    _J_: new WeakMap(),
    _K_: new WeakMap(),
    d_: new WeakMap(),
    _L_: new WeakMap(),
    _M_: new WeakMap()
};
});
$_mod.def("/marko$4.16.3/dist/components/util-browser", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.16.3/dist/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.d_;
var keysByDOMNode = domData._M_;
var vElementsByDOMNode = domData._K_;
var vPropsByDOMNode = domData._J_;
var markoUID = window.$MUID || (window.$MUID = { i: 0 });
var runtimeId = markoUID.i++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getParentComponentForEl(node) {
    while (node && !componentsByDOMNode.get(node)) {
        node = node.previousSibling || node.parentNode;
        node = node && node.fragment || node;
    }
    return node && componentsByDOMNode.get(node);
}

function getComponentForEl(el, doc) {
    if (el) {
        var node = typeof el == "string" ? (doc || defaultDocument).getElementById(el) : el;
        if (node) {
            return getParentComponentForEl(node);
        }
    }
}

var lifecycleEventMethods = {};

["create", "render", "update", "mount", "destroy"].forEach(function (eventName) {
    lifecycleEventMethods[eventName] = "on" + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
    var listenerMethod = component[lifecycleEventMethods[eventType]];

    if (listenerMethod !== undefined) {
        listenerMethod.call(component, eventArg1, eventArg2);
    }

    component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForNode(node) {
    var componentToDestroy = componentsByDOMNode.get(node.fragment || node);
    if (componentToDestroy) {
        componentToDestroy.y_();
        delete componentLookup[componentToDestroy.id];
    }
}
function destroyNodeRecursive(node, component) {
    destroyComponentForNode(node);
    if (node.nodeType === 1 || node.nodeType === 12) {
        var key;

        if (component && (key = keysByDOMNode.get(node))) {
            if (node === component.v_[key]) {
                if (componentsByDOMNode.get(node) && /\[\]$/.test(key)) {
                    delete component.v_[key][componentsByDOMNode.get(node).id];
                } else {
                    delete component.v_[key];
                }
            }
        }

        var curChild = node.firstChild;
        while (curChild && curChild !== node.endNode) {
            destroyNodeRecursive(curChild, component);
            curChild = curChild.nextSibling;
        }
    }
}

function nextComponentId() {
    // Each component will get an ID that is unique across all loaded
    // marko runtimes. This allows multiple instances of marko to be
    // loaded in the same window and they should all place nice
    // together
    return "c" + markoUID.i++;
}

function nextComponentIdProvider() {
    return nextComponentId;
}

function attachBubblingEvent(componentDef, handlerMethodName, isOnce, extraArgs) {
    if (handlerMethodName) {
        var componentId = componentDef.id;
        if (extraArgs) {
            return [handlerMethodName, componentId, isOnce, extraArgs];
        } else {
            return [handlerMethodName, componentId, isOnce];
        }
    }
}

function getMarkoPropsFromEl(el) {
    var vElement = vElementsByDOMNode.get(el);
    var virtualProps;

    if (vElement) {
        virtualProps = vElement.ap_;
    } else {
        virtualProps = vPropsByDOMNode.get(el);
        if (!virtualProps) {
            virtualProps = el.getAttribute("data-marko");
            vPropsByDOMNode.set(el, virtualProps = virtualProps ? JSON.parse(virtualProps) : EMPTY_OBJECT);
        }
    }

    return virtualProps;
}

function normalizeComponentKey(key, parentId) {
    if (key[0] === "#") {
        key = key.replace("#" + parentId + "-", "");
    }
    return key;
}

function addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId) {
    if (/\[\]$/.test(key)) {
        var repeatedElementsForKey = keyedElements[key] = keyedElements[key] || {};
        repeatedElementsForKey[componentId] = rootNode;
    } else {
        keyedElements[key] = rootNode;
    }
}

exports._N_ = runtimeId;
exports.a_ = componentLookup;
exports._R_ = getComponentForEl;
exports.b_ = emitLifecycleEvent;
exports.aq_ = destroyComponentForNode;
exports.c_ = destroyNodeRecursive;
exports._w_ = nextComponentIdProvider;
exports.Z_ = attachBubblingEvent;
exports._O_ = getMarkoPropsFromEl;
exports._V_ = addComponentRootToKeyedElements;
exports.ar_ = normalizeComponentKey;
});
$_mod.remap("/marko$4.16.3/dist/components/init-components", "/marko$4.16.3/dist/components/init-components-browser");
$_mod.installed("marko$4.16.3", "warp10", "2.0.1");
$_mod.def("/warp10$2.0.1/src/constants", function(require, exports, module, __filename, __dirname) { var win = typeof window !== "undefined" ? window : global;
exports.NOOP = win.$W10NOOP = win.$W10NOOP || function () {};
});
$_mod.def("/warp10$2.0.1/src/finalize", function(require, exports, module, __filename, __dirname) { var constants = require('/warp10$2.0.1/src/constants'/*"./constants"*/);
var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else if (info.type === 'NOOP') {
        return constants.NOOP;
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$2.0.1/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$2.0.1/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.16.3/dist/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var runtimeId = componentsUtil._N_;
var componentLookup = componentsUtil.a_;
var getMarkoPropsFromEl = componentsUtil._O_;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = "$MDE" + runtimeId;
var delegatedEvents = {};

function getEventFromEl(el, eventName) {
    var virtualProps = getMarkoPropsFromEl(el);
    var eventInfo = virtualProps[eventName];

    if (typeof eventInfo === "string") {
        eventInfo = eventInfo.split(" ");
        if (eventInfo[2]) {
            eventInfo[2] = eventInfo[2] === "true";
        }
        if (eventInfo.length == 4) {
            eventInfo[3] = parseInt(eventInfo[3], 10);
        }
    }

    return eventInfo;
}

function delegateEvent(node, eventName, target, event) {
    var targetMethod = target[0];
    var targetComponentId = target[1];
    var isOnce = target[2];
    var extraArgs = target[3];

    if (isOnce) {
        var virtualProps = getMarkoPropsFromEl(node);
        delete virtualProps[eventName];
    }

    var targetComponent = componentLookup[targetComponentId];

    if (!targetComponent) {
        return;
    }

    var targetFunc = typeof targetMethod === "function" ? targetMethod : targetComponent[targetMethod];
    if (!targetFunc) {
        throw Error("Method not found: " + targetMethod);
    }

    if (extraArgs != null) {
        if (typeof extraArgs === "number") {
            extraArgs = targetComponent.k_[extraArgs];
        }
    }

    // Invoke the component method
    if (extraArgs) {
        targetFunc.apply(targetComponent, extraArgs.concat(event, node));
    } else {
        targetFunc.call(targetComponent, event, node);
    }
}

function addDelegatedEventHandler(eventType) {
    if (!delegatedEvents[eventType]) {
        delegatedEvents[eventType] = true;
    }
}

function addDelegatedEventHandlerToDoc(eventType, doc) {
    var body = doc.body || doc;
    var listeners = doc[listenersAttachedKey] = doc[listenersAttachedKey] || {};
    if (!listeners[eventType]) {
        body.addEventListener(eventType, listeners[eventType] = function (event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function () {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            var curNode = event.target;
            if (!curNode) {
                return;
            }

            // event.target of an SVGElementInstance does not have a
            // `getAttribute` function in IE 11.
            // See https://github.com/marko-js/marko/issues/796
            curNode = curNode.correspondingUseElement || curNode;

            // Search up the tree looking DOM events mapped to target
            // component methods
            var propName = "on" + eventType;
            var target;

            // Attributes will have the following form:
            // on<event_type>("<target_method>|<component_id>")

            do {
                if (target = getEventFromEl(curNode, propName)) {
                    delegateEvent(curNode, propName, target, event);

                    if (propagationStopped) {
                        break;
                    }
                }
            } while ((curNode = curNode.parentNode) && curNode.getAttribute);
        }, true);
    }
}

function noop() {}

exports._I_ = noop;
exports.z_ = noop;
exports._F_ = delegateEvent;
exports._G_ = getEventFromEl;
exports.___ = addDelegatedEventHandler;
exports._P_ = function (doc) {
    Object.keys(delegatedEvents).forEach(function (eventType) {
        addDelegatedEventHandlerToDoc(eventType, doc);
    });
};
});
$_mod.def("/marko$4.16.3/dist/morphdom/helpers", function(require, exports, module, __filename, __dirname) { function insertBefore(node, referenceNode, parentNode) {
    if (node.insertInto) {
        return node.insertInto(parentNode, referenceNode);
    }
    return parentNode.insertBefore(node, referenceNode && referenceNode.startNode || referenceNode);
}

function insertAfter(node, referenceNode, parentNode) {
    return insertBefore(node, referenceNode && referenceNode.nextSibling, parentNode);
}

function nextSibling(node) {
    var next = node.nextSibling;
    var fragment = next && next.fragment;
    if (fragment) {
        return next === fragment.startNode ? fragment : null;
    }
    return next;
}

function firstChild(node) {
    var next = node.firstChild;
    return next && next.fragment || next;
}

function removeChild(node) {
    if (node.remove) node.remove();else node.parentNode.removeChild(node);
}

exports.as_ = insertBefore;
exports.av_ = insertAfter;
exports.aw_ = nextSibling;
exports.S_ = firstChild;
exports.ax_ = removeChild;
});
$_mod.def("/marko$4.16.3/dist/morphdom/fragment", function(require, exports, module, __filename, __dirname) { var helpers = require('/marko$4.16.3/dist/morphdom/helpers'/*"./helpers"*/);
var insertBefore = helpers.as_;

var fragmentPrototype = {
    nodeType: 12,
    get firstChild() {
        var firstChild = this.startNode.nextSibling;
        return firstChild === this.endNode ? undefined : firstChild;
    },
    get lastChild() {
        var lastChild = this.endNode.previousSibling;
        return lastChild === this.startNode ? undefined : lastChild;
    },
    get parentNode() {
        var parentNode = this.startNode.parentNode;
        return parentNode === this.detachedContainer ? undefined : parentNode;
    },
    get nextSibling() {
        return this.endNode.nextSibling;
    },
    get nodes() {
        var nodes = [];
        var current = this.startNode;
        while (current !== this.endNode) {
            nodes.push(current);
            current = current.nextSibling;
        }
        nodes.push(current);
        return nodes;
    },
    insertBefore: function (newChildNode, referenceNode) {
        var actualReference = referenceNode == null ? this.endNode : referenceNode;
        return insertBefore(newChildNode, actualReference, this.startNode.parentNode);
    },
    insertInto: function (newParentNode, referenceNode) {
        this.nodes.forEach(function (node) {
            insertBefore(node, referenceNode, newParentNode);
        }, this);
        return this;
    },
    remove: function () {
        this.nodes.forEach(function (node) {
            this.detachedContainer.appendChild(node);
        }, this);
    }
};

function createFragmentNode(startNode, nextNode, parentNode) {
    var fragment = Object.create(fragmentPrototype);
    fragment.startNode = document.createTextNode("");
    fragment.endNode = document.createTextNode("");
    fragment.startNode.fragment = fragment;
    fragment.endNode.fragment = fragment;
    var detachedContainer = fragment.detachedContainer = document.createDocumentFragment();
    parentNode = parentNode || startNode && startNode.parentNode || detachedContainer;
    insertBefore(fragment.startNode, startNode, parentNode);
    insertBefore(fragment.endNode, nextNode, parentNode);
    return fragment;
}

function beginFragmentNode(startNode, parentNode) {
    var fragment = createFragmentNode(startNode, null, parentNode);
    fragment.at_ = function (nextNode) {
        fragment.at_ = null;
        insertBefore(fragment.endNode, nextNode, parentNode || startNode.parentNode);
    };
    return fragment;
}

exports._U_ = createFragmentNode;
exports.au_ = beginFragmentNode;
});
$_mod.installed("marko$4.16.3", "raptor-util", "3.2.0");
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/marko$4.16.3/dist/components/KeySequence", function(require, exports, module, __filename, __dirname) { function KeySequence() {
    this._B_ = {};
}

KeySequence.prototype = {
    _i_: function (key) {
        // var len = key.length;
        // var lastChar = key[len-1];
        // if (lastChar === ']') {
        //     key = key.substring(0, len-2);
        // }
        var lookup = this._B_;

        var currentIndex = lookup[key]++;
        if (!currentIndex) {
            lookup[key] = 1;
            currentIndex = 0;
            return key;
        } else {
            return key + "_" + currentIndex;
        }
    }
};

module.exports = KeySequence;
});
$_mod.def("/marko$4.16.3/dist/components/ComponentDef", function(require, exports, module, __filename, __dirname) { "use strict";

var componentUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var attachBubblingEvent = componentUtil.Z_;
var addDelegatedEventHandler = require('/marko$4.16.3/dist/components/event-delegation'/*"./event-delegation"*/).___;
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var KeySequence = require('/marko$4.16.3/dist/components/KeySequence'/*"./KeySequence"*/);

var FLAG_WILL_RERENDER_IN_BROWSER = 1;
// var FLAG_HAS_BODY_EL = 2;
// var FLAG_HAS_HEAD_EL = 4;
var FLAG_OLD_HYDRATE_NO_CREATE = 8;

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, globalComponentsContext) {
    this._a_ = globalComponentsContext; // The AsyncWriter that this component is associated with
    this._b_ = component;
    this.id = componentId;

    this._c_ = undefined; // An array of DOM events that need to be added (in sets of three)

    this._d_ = false;

    this._e_ = false;
    this._f_ = 0;

    this._g_ = 0; // The unique integer to use for the next scoped ID

    this.w_ = null;

    this._h_ = null;
}

ComponentDef.prototype = {
    _i_: function (key) {
        var keySequence = this.w_ || (this.w_ = new KeySequence());
        return keySequence._i_(key);
    },

    _j_: function (key, bodyOnly) {
        var lookup = this._h_ || (this._h_ = {});
        lookup[key] = bodyOnly ? 2 : 1;
    },

    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current component. This method prefixes
     * the the nestedId with the ID of the current component. If nestedId ends
     * with `[]` then it is treated as a repeated ID and we will generate
     * an ID with the current index for the current nestedId.
     * (e.g. "myParentId-foo[0]", "myParentId-foo[1]", etc.)
     */
    elId: function (nestedId) {
        var id = this.id;
        if (nestedId == null) {
            return id;
        } else {
            if (nestedId.indexOf("#") === 0) {
                id = "#" + id;
                nestedId = nestedId.substring(1);
            }

            return id + "-" + nestedId;
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
     */
    _k_: function () {
        return this.id + "-c" + this._g_++;
    },

    d: function (eventName, handlerMethodName, isOnce, extraArgs) {
        addDelegatedEventHandler(eventName);
        return attachBubblingEvent(this, handlerMethodName, isOnce, extraArgs);
    },

    get _l_() {
        return this._b_._l_;
    }
};

ComponentDef._m_ = function (o, types, global, registry) {
    var id = o[0];
    var typeName = types[o[1]];
    var input = o[2];
    var extra = o[3];

    var isLegacy = extra.l;
    var state = extra.s;
    var componentProps = extra.w;
    var flags = extra.f;

    var component = typeName /* legacy */ && registry._n_(typeName, id, isLegacy);

    // Prevent newly created component from being queued for update since we area
    // just building it from the server info
    component.r_ = true;

    if (!isLegacy && flags & FLAG_WILL_RERENDER_IN_BROWSER && !(flags & FLAG_OLD_HYDRATE_NO_CREATE)) {
        if (component.onCreate) {
            component.onCreate(input, { global: global });
        }
        if (component.onInput) {
            input = component.onInput(input, { global: global }) || input;
        }
    } else {
        if (state) {
            var undefinedPropNames = extra.u;
            if (undefinedPropNames) {
                undefinedPropNames.forEach(function (undefinedPropName) {
                    state[undefinedPropName] = undefined;
                });
            }
            // We go through the setter here so that we convert the state object
            // to an instance of `State`
            component.state = state;
        }

        if (componentProps) {
            extend(component, componentProps);
        }
    }

    component.n_ = input;

    if (extra.b) {
        component.k_ = extra.b;
    }

    var scope = extra.p;
    var customEvents = extra.e;
    if (customEvents) {
        component.W_(customEvents, scope);
    }

    component.p_ = global;

    return {
        id: id,
        _b_: component,
        _o_: extra.r,
        _c_: extra.d,
        _f_: extra.f || 0
    };
};

module.exports = ComponentDef;
});
$_mod.remap("/marko$4.16.3/dist/components/registry", "/marko$4.16.3/dist/components/registry-browser");
$_mod.def("/marko$4.16.3/dist/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function ensure(state, propertyName) {
    var proto = state.constructor.prototype;
    if (!(propertyName in proto)) {
        Object.defineProperty(proto, propertyName, {
            get: function () {
                return this.V_[propertyName];
            },
            set: function (value) {
                this.E_(propertyName, value, false /* ensure:false */);
            }
        });
    }
}

function State(component) {
    this._b_ = component;
    this.V_ = {};

    this.s_ = false;
    this.K_ = null;
    this.J_ = null;
    this._E_ = null; // An object that we use to keep tracking of state properties that were forced to be dirty

    Object.seal(this);
}

State.prototype = {
    f_: function () {
        var self = this;

        self.s_ = false;
        self.K_ = null;
        self.J_ = null;
        self._E_ = null;
    },

    C_: function (newState) {
        var state = this;
        var key;

        var rawState = this.V_;

        for (key in rawState) {
            if (!(key in newState)) {
                state.E_(key, undefined, false /* ensure:false */
                , false /* forceDirty:false */
                );
            }
        }

        for (key in newState) {
            state.E_(key, newState[key], true /* ensure:true */
            , false /* forceDirty:false */
            );
        }
    },
    E_: function (name, value, shouldEnsure, forceDirty) {
        var rawState = this.V_;

        if (shouldEnsure) {
            ensure(this, name);
        }

        if (forceDirty) {
            var forcedDirtyState = this._E_ || (this._E_ = {});
            forcedDirtyState[name] = true;
        } else if (rawState[name] === value) {
            return;
        }

        if (!this.s_) {
            // This is the first time we are modifying the component state
            // so introduce some properties to do some tracking of
            // changes to the state
            this.s_ = true; // Mark the component state as dirty (i.e. modified)
            this.K_ = rawState;
            this.V_ = rawState = extend({}, rawState);
            this.J_ = {};
            this._b_.D_();
        }

        this.J_[name] = value;

        if (value === undefined) {
            // Don't store state properties with an undefined or null value
            delete rawState[name];
        } else {
            // Otherwise, store the new value in the component state
            rawState[name] = value;
        }
    },
    toJSON: function () {
        return this.V_;
    }
};

module.exports = State;
});
$_mod.def("/marko$4.16.3/dist/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"../components/util"*/);
var destroyComponentForNode = componentsUtil.aq_;
var destroyNodeRecursive = componentsUtil.c_;
var helpers = require('/marko$4.16.3/dist/morphdom/helpers'/*"../morphdom/helpers"*/);

var insertBefore = helpers.as_;
var insertAfter = helpers.av_;
var removeChild = helpers.ax_;

function resolveEl(el) {
    if (typeof el == "string") {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw Error("Not found: " + elId);
        }
    }
    return el;
}

function beforeRemove(referenceEl) {
    destroyNodeRecursive(referenceEl);
    destroyComponentForNode(referenceEl);
}

module.exports = function (target, getEl, afterInsert) {
    extend(target, {
        appendTo: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        prependTo: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl.firstChild || null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        replace: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            beforeRemove(referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            removeChild(referenceEl);
            return afterInsert(this, referenceEl);
        },
        replaceChildrenOf: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);

            var curChild = referenceEl.firstChild;
            while (curChild) {
                var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
                beforeRemove(curChild);
                curChild = nextSibling;
            }

            referenceEl.innerHTML = "";
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        insertBefore: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        },
        insertAfter: function (referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertAfter(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        }
    });
};
});
$_mod.def("/marko$4.16.3/dist/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
    actualCreateOut = createOutFunc;
}

function createOut(globalData) {
    return actualCreateOut(globalData);
}

createOut.aM_ = setCreateOut;

module.exports = createOut;
});
$_mod.def("/marko$4.16.3/dist/components/GlobalComponentsContext", function(require, exports, module, __filename, __dirname) { var nextComponentIdProvider = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/)._w_;
var KeySequence = require('/marko$4.16.3/dist/components/KeySequence'/*"./KeySequence"*/);

function GlobalComponentsContext(out) {
    this._x_ = {};
    this._y_ = {};
    this._z_ = {};
    this.P_ = undefined;
    this._k_ = nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
    _A_: function () {
        return new KeySequence();
    }
};

module.exports = GlobalComponentsContext;
});
$_mod.def("/marko$4.16.3/dist/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { "use strict";

var GlobalComponentsContext = require('/marko$4.16.3/dist/components/GlobalComponentsContext'/*"./GlobalComponentsContext"*/);

function ComponentsContext(out, parentComponentsContext) {
    var globalComponentsContext;
    var componentDef;

    if (parentComponentsContext) {
        globalComponentsContext = parentComponentsContext.O_;
        componentDef = parentComponentsContext._p_;

        var nestedContextsForParent;
        if (!(nestedContextsForParent = parentComponentsContext._q_)) {
            nestedContextsForParent = parentComponentsContext._q_ = [];
        }

        nestedContextsForParent.push(this);
    } else {
        globalComponentsContext = out.global._r_;
        if (globalComponentsContext === undefined) {
            out.global._r_ = globalComponentsContext = new GlobalComponentsContext(out);
        }
    }

    this.O_ = globalComponentsContext;
    this._r_ = [];
    this._s_ = out;
    this._p_ = componentDef;
    this._q_ = undefined;
}

ComponentsContext.prototype = {
    _t_: function (doc) {
        var componentDefs = this._r_;

        ComponentsContext._u_(componentDefs, doc);

        this._s_.emit("_v_");

        // Reset things stored in global since global is retained for
        // future renders
        this._s_.global._r_ = undefined;

        return componentDefs;
    }
};

function getComponentsContext(out) {
    return out._r_ || (out._r_ = new ComponentsContext(out));
}

module.exports = exports = ComponentsContext;

exports.__ = getComponentsContext;
});
$_mod.installed("marko$4.16.3", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src\\index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.16.3/dist/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.16.3/dist/runtime/dom-insert'/*"./dom-insert"*/);

function getComponentDefs(result) {
    var componentDefs = result._r_;

    if (!componentDefs) {
        throw Error("No component");
    }
    return componentDefs;
}

function RenderResult(out) {
    this.out = this._s_ = out;
    this._r_ = undefined;
}

module.exports = RenderResult;

var proto = RenderResult.prototype = {
    getComponent: function () {
        return this.getComponents()[0];
    },
    getComponents: function (selector) {
        if (this._r_ === undefined) {
            throw Error("Not added to DOM");
        }

        var componentDefs = getComponentDefs(this);

        var components = [];

        componentDefs.forEach(function (componentDef) {
            var component = componentDef._b_;
            if (!selector || selector(component)) {
                components.push(component);
            }
        });

        return components;
    },

    afterInsert: function (doc) {
        var out = this._s_;
        var componentsContext = out._r_;
        if (componentsContext) {
            this._r_ = componentsContext._t_(doc);
        } else {
            this._r_ = null;
        }

        return this;
    },
    getNode: function (doc) {
        return this._s_.aL_(doc);
    },
    getOutput: function () {
        return this._s_.R_();
    },
    toString: function () {
        return this._s_.toString();
    },
    document: typeof document != "undefined" && document
};

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(proto, function getEl(renderResult, referenceEl) {
    return renderResult.getNode(referenceEl.ownerDocument);
}, function afterInsert(renderResult, referenceEl) {
    var isShadow = typeof ShadowRoot === "function" && referenceEl instanceof ShadowRoot;
    return renderResult.afterInsert(isShadow ? referenceEl : referenceEl.ownerDocument);
});
});
$_mod.installed("marko$4.16.3", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib\\listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.remap("/marko$4.16.3/dist/runtime/nextTick", "/marko$4.16.3/dist/runtime/nextTick-browser");
$_mod.def("/marko$4.16.3/dist/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
    if (win.postMessage) {
        var queue = [];
        var messageName = "si";
        win.addEventListener("message", function (event) {
            var source = event.source;
            if (source == win || !source && event.data === messageName) {
                event.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        setImmediate = function (fn) {
            queue.push(fn);
            win.postMessage(messageName, "*");
        };
    } else {
        setImmediate = setTimeout;
    }
}

module.exports = setImmediate;
});
$_mod.def("/marko$4.16.3/dist/components/update-manager", function(require, exports, module, __filename, __dirname) { "use strict";

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.16.3/dist/runtime/nextTick-browser'/*"../runtime/nextTick"*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
    if (unbatchedQueue.length) {
        try {
            updateComponents(unbatchedQueue);
        } finally {
            // Reset the flag now that this scheduled batch update
            // is complete so that we can later schedule another
            // batched update if needed
            updatesScheduled = false;
        }
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
    // Loop over the components in the queue and update them.
    // NOTE: It is okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i = 0; i < queue.length; i++) {
        var component = queue[i];
        component.X_(); // Do the actual component update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var batch = {
        ao_: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the components that where queued up
            // in this batch (if any)
            if (batch.ao_) {
                updateComponents(batch.ao_);
            }
        } finally {
            // Now that we have completed the update of all the components
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;
        }
    }
}

function queueComponentUpdate(component) {
    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the component on the top batch. When
        // the batch is ended this component will be updated.
        var batch = batchStack[batchStackLen - 1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.ao_) {
            batch.ao_.push(component);
        } else {
            batch.ao_ = [component];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the component to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(component);
    }
}

exports.H_ = queueComponentUpdate;
exports.N_ = batchUpdate;
});
$_mod.main("/marko$4.16.3/dist/morphdom", "");
$_mod.def("/marko$4.16.3/dist/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
    if (fromEl[name] !== toEl[name]) {
        fromEl[name] = toEl[name];
        if (fromEl[name]) {
            fromEl.setAttribute(name, "");
        } else {
            fromEl.removeAttribute(name, "");
        }
    }
}

// We use a JavaScript class to benefit from fast property lookup
function SpecialElHandlers() {}
SpecialElHandlers.prototype = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    OPTION: function (fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "selected");
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    INPUT: function (fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "checked");
        syncBooleanAttrProp(fromEl, toEl, "disabled");

        if (fromEl.value != toEl.aJ_) {
            fromEl.value = toEl.aJ_;
        }

        if (fromEl.hasAttribute("value") && !toEl.aK_("value")) {
            fromEl.removeAttribute("value");
        }
    },

    TEXTAREA: function (fromEl, toEl) {
        var newValue = toEl.aJ_;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        var firstChild = fromEl.firstChild;
        if (firstChild) {
            // Needed for IE. Apparently IE sets the placeholder as the
            // node value and vise versa. This ignores an empty update.
            var oldValue = firstChild.nodeValue;

            if (oldValue == newValue || !newValue && oldValue == fromEl.placeholder) {
                return;
            }

            firstChild.nodeValue = newValue;
        }
    },
    SELECT: function (fromEl, toEl) {
        if (!toEl.aK_("multiple")) {
            var i = -1;
            var selected = 0;
            var curChild = toEl.S_;
            while (curChild) {
                if (curChild.aB_ == "OPTION") {
                    i++;
                    if (curChild.aK_("selected")) {
                        selected = i;
                    }
                }
                curChild = curChild.aw_;
            }

            if (fromEl.selectedIndex !== selected) {
                fromEl.selectedIndex = selected;
            }
        }
    }
};

module.exports = new SpecialElHandlers();
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
function VNode() {}

VNode.prototype = {
    bv_: function (finalChildCount) {
        this.bG_ = finalChildCount;
        this.bH_ = 0;
        this.bz_ = null;
        this.bI_ = null;
        this.bw_ = null;
        this.bx_ = null;
    },

    aF_: null,

    get S_() {
        var firstChild = this.bz_;

        if (firstChild && firstChild.by_) {
            var nestedFirstChild = firstChild.S_;
            // The first child is a DocumentFragment node.
            // If the DocumentFragment node has a first child then we will return that.
            // Otherwise, the DocumentFragment node is not *really* the first child and
            // we need to skip to its next sibling
            return nestedFirstChild || firstChild.aw_;
        }

        return firstChild;
    },

    get aw_() {
        var nextSibling = this.bx_;

        if (nextSibling) {
            if (nextSibling.by_) {
                var firstChild = nextSibling.S_;
                return firstChild || nextSibling.aw_;
            }
        } else {
            var parentNode = this.bw_;
            if (parentNode && parentNode.by_) {
                return parentNode.aw_;
            }
        }

        return nextSibling;
    },

    bn_: function (child) {
        this.bH_++;

        if (this.bD_ === true) {
            if (child.bJ_) {
                var childValue = child.aH_;
                this.bC_ = (this.bC_ || "") + childValue;
            } else {
                throw TypeError();
            }
        } else {
            var lastChild = this.bI_;

            child.bw_ = this;

            if (lastChild) {
                lastChild.bx_ = child;
            } else {
                this.bz_ = child;
            }

            this.bI_ = child;
        }

        return child;
    },

    bE_: function finishChild() {
        if (this.bH_ === this.bG_ && this.bw_) {
            return this.bw_.bE_();
        } else {
            return this;
        }
    }

    // ,toJSON: function() {
    //     var clone = Object.assign({
    //         nodeType: this.nodeType
    //     }, this);
    //
    //     for (var k in clone) {
    //         if (k.startsWith('_')) {
    //             delete clone[k];
    //         }
    //     }
    //     delete clone._nextSibling;
    //     delete clone._lastChild;
    //     delete clone.parentNode;
    //     return clone;
    // }
};

module.exports = VNode;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComment(value) {
    this.bv_(-1 /* no children */);
    this.aH_ = value;
}

VComment.prototype = {
    aD_: 8,

    aC_: function (doc) {
        var nodeValue = this.aH_;
        return doc.createComment(nodeValue);
    },

    bp_: function () {
        return new VComment(this.aH_);
    }
};

inherit(VComment, VNode);

module.exports = VComment;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function VDocumentFragmentClone(other) {
    extend(this, other);
    this.bw_ = null;
    this.bx_ = null;
}

function VDocumentFragment(out) {
    this.bv_(null /* childCount */);
    this._s_ = out;
}

VDocumentFragment.prototype = {
    aD_: 11,

    by_: true,

    bp_: function () {
        return new VDocumentFragmentClone(this);
    },

    aC_: function (doc) {
        return doc.createDocumentFragment();
    }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var domData = require('/marko$4.16.3/dist/components/dom-data'/*"../../components/dom-data"*/);
var vElementByDOMNode = domData._K_;
var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var NS_XLINK = "http://www.w3.org/1999/xlink";
var ATTR_XLINK_HREF = "xlink:href";
var xmlnsRegExp = /^xmlns(:|$)/;

var toString = String;

var FLAG_IS_SVG = 1;
var FLAG_IS_TEXTAREA = 2;
var FLAG_SIMPLE_ATTRS = 4;
// var FLAG_PRESERVE = 8;
var FLAG_CUSTOM_ELEMENT = 16;

var defineProperty = Object.defineProperty;

var ATTR_HREF = "href";
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
    if (value === true) {
        return "";
    } else if (type == "object") {
        return JSON.stringify(value);
    } else {
        return toString(value);
    }
}

function assign(a, b) {
    for (var key in b) {
        if (b.hasOwnProperty(key)) {
            a[key] = b[key];
        }
    }
}

function setAttribute(el, namespaceURI, name, value) {
    if (namespaceURI === null) {
        el.setAttribute(name, value);
    } else {
        el.setAttributeNS(namespaceURI, name, value);
    }
}

function removeAttribute(el, namespaceURI, name) {
    if (namespaceURI === null) {
        el.removeAttribute(name);
    } else {
        el.removeAttributeNS(namespaceURI, name);
    }
}

function VElementClone(other) {
    this.bz_ = other.bz_;
    this.bw_ = null;
    this.bx_ = null;

    this.aE_ = other.aE_;
    this.bA_ = other.bA_;
    this.ap_ = other.ap_;
    this.bB_ = other.bB_;
    this.aB_ = other.aB_;
    this._f_ = other._f_;
    this.bC_ = other.bC_;
    this.aI_ = other.aI_;
    this.bD_ = other.bD_;
}

function VElement(tagName, attrs, key, ownerComponent, childCount, flags, props) {
    this.bv_(childCount);

    var constId;
    var namespaceURI;
    var isTextArea;

    if (props) {
        constId = props.i;
    }

    if (this._f_ = flags || 0) {
        if (flags & FLAG_IS_SVG) {
            namespaceURI = "http://www.w3.org/2000/svg";
        }
        if (flags & FLAG_IS_TEXTAREA) {
            isTextArea = true;
        }
    }

    this.aE_ = key;
    this.aF_ = ownerComponent;
    this.bA_ = attrs || EMPTY_OBJECT;
    this.ap_ = props || EMPTY_OBJECT;
    this.bB_ = namespaceURI;
    this.aB_ = tagName;
    this.bC_ = null;
    this.aI_ = constId;
    this.bD_ = isTextArea;
}

VElement.prototype = {
    aD_: 1,

    bp_: function () {
        return new VElementClone(this);
    },

    /**
     * Shorthand method for creating and appending an HTML element
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    e: function (tagName, attrs, key, ownerComponent, childCount, flags, props) {
        var child = this.bn_(new VElement(tagName, attrs, key, ownerComponent, childCount, flags, props));

        if (childCount === 0) {
            return this.bE_();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending an HTML element with a dynamic namespace
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    ed: function (tagName, attrs, key, ownerComponent, childCount, flags, props) {
        var child = this.bn_(VElement.bo_(tagName, attrs, key, ownerComponent, childCount, flags, props));

        if (childCount === 0) {
            return this.bE_();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending a static node. The provided node is automatically cloned
     * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
     *
     * @param  {String} value The value for the new Comment node
     */
    n: function (node, ownerComponent) {
        node = node.bp_();
        node.aF_ = ownerComponent;
        this.bn_(node);
        return this.bE_();
    },

    aC_: function (doc) {
        var namespaceURI = this.bB_;
        var tagName = this.aB_;

        var attributes = this.bA_;
        var flags = this._f_;

        var el = namespaceURI !== undefined ? doc.createElementNS(namespaceURI, tagName) : doc.createElement(tagName);

        if (flags & FLAG_CUSTOM_ELEMENT) {
            assign(el, attributes);
        } else {
            for (var attrName in attributes) {
                var attrValue = attributes[attrName];

                if (attrValue !== false && attrValue != null) {
                    var type = typeof attrValue;

                    if (type !== "string") {
                        // Special attributes aren't copied to the real DOM. They are only
                        // kept in the virtual attributes map
                        attrValue = convertAttrValue(type, attrValue);
                    }

                    if (attrName == ATTR_XLINK_HREF) {
                        setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
                    } else {
                        el.setAttribute(attrName, attrValue);
                    }
                }
            }

            if (flags & FLAG_IS_TEXTAREA) {
                el.value = this.aJ_;
            }
        }

        vElementByDOMNode.set(el, this);

        return el;
    },

    aK_: function (name) {
        // We don't care about the namespaces since the there
        // is no chance that attributes with the same name will have
        // different namespaces
        var value = this.bA_[name];
        return value != null && value !== false;
    }
};

inherit(VElement, VNode);

var proto = VElementClone.prototype = VElement.prototype;

["checked", "selected", "disabled"].forEach(function (name) {
    defineProperty(proto, name, {
        get: function () {
            var value = this.bA_[name];
            return value !== false && value != null;
        }
    });
});

defineProperty(proto, "aJ_", {
    get: function () {
        var value = this.bC_;
        if (value == null) {
            value = this.bA_.value;
        }
        return value != null ? toString(value) : this.bA_.type === "checkbox" || this.bA_.type === "radio" ? "on" : "";
    }
});

VElement.bo_ = function (tagName, attrs, key, ownerComponent, childCount, flags, props) {
    var namespace = attrs && attrs.xmlns;
    tagName = namespace ? tagName : tagName.toUpperCase();
    var element = new VElement(tagName, attrs, key, ownerComponent, childCount, flags, props);
    element.bB_ = namespace;
    return element;
};

VElement.bF_ = function (attrs) {
    // By default this static method is a no-op, but if there are any
    // compiled components that have "no-update" attributes then
    // `preserve-attrs.js` will be imported and this method will be replaced
    // with a method that actually does something
    return attrs;
};

function virtualizeElement(node, virtualizeChildNodes) {
    var attributes = node.attributes;
    var attrCount = attributes.length;

    var attrs;

    if (attrCount) {
        attrs = {};
        for (var i = 0; i < attrCount; i++) {
            var attr = attributes[i];
            var attrName = attr.name;
            if (!xmlnsRegExp.test(attrName) && attrName !== "data-marko") {
                var attrNamespaceURI = attr.namespaceURI;
                if (attrNamespaceURI === NS_XLINK) {
                    attrs[ATTR_XLINK_HREF] = attr.value;
                } else {
                    attrs[attrName] = attr.value;
                }
            }
        }
    }

    var flags = 0;

    var tagName = node.nodeName;
    if (tagName === "TEXTAREA") {
        flags |= FLAG_IS_TEXTAREA;
    }

    var vdomEl = new VElement(tagName, attrs, null /*key*/
    , null /*ownerComponent*/
    , 0 /*child count*/
    , flags, null /*props*/
    );
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        vdomEl.bB_ = node.namespaceURI;
    }

    if (vdomEl.bD_) {
        vdomEl.bC_ = node.value;
    } else {
        if (virtualizeChildNodes) {
            virtualizeChildNodes(node, vdomEl);
        }
    }

    return vdomEl;
}

VElement.az_ = virtualizeElement;

VElement.aA_ = function (fromEl, vFromEl, toEl) {
    var removePreservedAttributes = VElement.bF_;

    var fromFlags = vFromEl._f_;
    var toFlags = toEl._f_;

    vElementByDOMNode.set(fromEl, toEl);

    var attrs = toEl.bA_;
    var props = toEl.ap_;

    if (toFlags & FLAG_CUSTOM_ELEMENT) {
        return assign(fromEl, attrs);
    }

    var attrName;

    // We use expando properties to associate the previous HTML
    // attributes provided as part of the VDOM node with the
    // real VElement DOM node. When diffing attributes,
    // we only use our internal representation of the attributes.
    // When diffing for the first time it's possible that the
    // real VElement node will not have the expando property
    // so we build the attribute map from the expando property

    var oldAttrs = vFromEl.bA_;

    if (oldAttrs) {
        if (oldAttrs === attrs) {
            // For constant attributes the same object will be provided
            // every render and we can use that to our advantage to
            // not waste time diffing a constant, immutable attribute
            // map.
            return;
        } else {
            oldAttrs = removePreservedAttributes(oldAttrs, props);
        }
    }

    var attrValue;

    if (toFlags & FLAG_SIMPLE_ATTRS && fromFlags & FLAG_SIMPLE_ATTRS) {
        if (oldAttrs["class"] !== (attrValue = attrs["class"])) {
            fromEl.className = attrValue;
        }
        if (oldAttrs.id !== (attrValue = attrs.id)) {
            fromEl.id = attrValue;
        }
        if (oldAttrs.style !== (attrValue = attrs.style)) {
            fromEl.style.cssText = attrValue;
        }
        return;
    }

    // In some cases we only want to set an attribute value for the first
    // render or we don't want certain attributes to be touched. To support
    // that use case we delete out all of the preserved attributes
    // so it's as if they never existed.
    attrs = removePreservedAttributes(attrs, props, true);

    var namespaceURI;

    // Loop over all of the attributes in the attribute map and compare
    // them to the value in the old map. However, if the value is
    // null/undefined/false then we want to remove the attribute
    for (attrName in attrs) {
        attrValue = attrs[attrName];
        namespaceURI = null;

        if (attrName === ATTR_XLINK_HREF) {
            namespaceURI = NS_XLINK;
            attrName = ATTR_HREF;
        }

        if (attrValue == null || attrValue === false) {
            removeAttribute(fromEl, namespaceURI, attrName);
        } else if (oldAttrs[attrName] !== attrValue) {
            var type = typeof attrValue;

            if (type !== "string") {
                attrValue = convertAttrValue(type, attrValue);
            }

            setAttribute(fromEl, namespaceURI, attrName, attrValue);
        }
    }

    // If there are any old attributes that are not in the new set of attributes
    // then we need to remove those attributes from the target node
    //
    // NOTE: We can skip this if the the element is keyed because if the element
    //       is keyed then we know we already processed all of the attributes for
    //       both the target and original element since target VElement nodes will
    //       have all attributes declared. However, we can only skip if the node
    //       was not a virtualized node (i.e., a node that was not rendered by a
    //       Marko template, but rather a node that was created from an HTML
    //       string or a real DOM node).
    if (toEl.aE_ === null) {
        for (attrName in oldAttrs) {
            if (!(attrName in attrs)) {
                if (attrName === ATTR_XLINK_HREF) {
                    fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
                } else {
                    fromEl.removeAttribute(attrName);
                }
            }
        }
    }
};

module.exports = VElement;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VText(value) {
    this.bv_(-1 /* no children */);
    this.aH_ = value;
}

VText.prototype = {
    bJ_: true,

    aD_: 3,

    aC_: function (doc) {
        return doc.createTextNode(this.aH_);
    },

    bp_: function () {
        return new VText(this.aH_);
    }
};

inherit(VText, VNode);

module.exports = VText;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VComponent", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComponent(component, key, ownerComponent, preserve) {
    this.bv_(null /* childCount */);
    this.aE_ = key;
    this._b_ = component;
    this.aF_ = ownerComponent;
    this.aG_ = preserve;
}

VComponent.prototype = {
    aD_: 2
};

inherit(VComponent, VNode);

module.exports = VComponent;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/VFragment", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.16.3/dist/components/dom-data'/*"../../components/dom-data"*/);
var keysByDOMNode = domData._M_;
var vElementByDOMNode = domData._K_;
var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var createFragmentNode = require('/marko$4.16.3/dist/morphdom/fragment'/*"../../morphdom/fragment"*/)._U_;

function VFragment(key, ownerComponent, preserve) {
    this.bv_(null /* childCount */);
    this.aE_ = key;
    this.aF_ = ownerComponent;
    this.aG_ = preserve;
}

VFragment.prototype = {
    aD_: 12,
    aC_: function () {
        var fragment = createFragmentNode();
        keysByDOMNode.set(fragment, this.aE_);
        vElementByDOMNode.set(fragment, this);
        return fragment;
    }
};

inherit(VFragment, VNode);

module.exports = VFragment;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.16.3/dist/runtime/vdom/VNode'/*"./VNode"*/);
var VComment = require('/marko$4.16.3/dist/runtime/vdom/VComment'/*"./VComment"*/);
var VDocumentFragment = require('/marko$4.16.3/dist/runtime/vdom/VDocumentFragment'/*"./VDocumentFragment"*/);
var VElement = require('/marko$4.16.3/dist/runtime/vdom/VElement'/*"./VElement"*/);
var VText = require('/marko$4.16.3/dist/runtime/vdom/VText'/*"./VText"*/);
var VComponent = require('/marko$4.16.3/dist/runtime/vdom/VComponent'/*"./VComponent"*/);
var VFragment = require('/marko$4.16.3/dist/runtime/vdom/VFragment'/*"./VFragment"*/);

var defaultDocument = typeof document != "undefined" && document;
var specialHtmlRegexp = /[&<]/;

function virtualizeChildNodes(node, vdomParent) {
    var curChild = node.firstChild;
    while (curChild) {
        vdomParent.bn_(virtualize(curChild));
        curChild = curChild.nextSibling;
    }
}

function virtualize(node) {
    switch (node.nodeType) {
        case 1:
            return VElement.az_(node, virtualizeChildNodes);
        case 3:
            return new VText(node.nodeValue);
        case 8:
            return new VComment(node.nodeValue);
        case 11:
            var vdomDocFragment = new VDocumentFragment();
            virtualizeChildNodes(node, vdomDocFragment);
            return vdomDocFragment;
    }
}

function virtualizeHTML(html, doc) {
    if (!specialHtmlRegexp.test(html)) {
        return new VText(html);
    }

    var container = doc.createElement("body");
    container.innerHTML = html;
    var vdomFragment = new VDocumentFragment();

    var curChild = container.firstChild;
    while (curChild) {
        vdomFragment.bn_(virtualize(curChild));
        curChild = curChild.nextSibling;
    }

    return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function (value) {
    var type = typeof value;
    var vdomNode;

    if (type !== "string") {
        if (value == null) {
            value = "";
        } else if (type === "object") {
            if (value.toHTML) {
                vdomNode = virtualizeHTML(value.toHTML(), document);
            }
        }
    }

    this.bn_(vdomNode || new VText(value.toString()));
    return this.bE_();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function (value) {
    this.bn_(new VComment(value));
    return this.bE_();
};

Node_prototype.bt_ = function () {
    return this.bn_(new VDocumentFragment());
};

exports.aX_ = VComment;
exports.aW_ = VDocumentFragment;
exports.ay_ = VElement;
exports.aY_ = VText;
exports.aZ_ = VComponent;
exports.b__ = VFragment;
exports.az_ = virtualize;
exports.ba_ = virtualizeHTML;
exports.bb_ = defaultDocument;
});
$_mod.def("/marko$4.16.3/dist/morphdom/index", function(require, exports, module, __filename, __dirname) { "use strict";

var specialElHandlers = require('/marko$4.16.3/dist/morphdom/specialElHandlers'/*"./specialElHandlers"*/);
var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"../components/util"*/);
var existingComponentLookup = componentsUtil.a_;
var destroyNodeRecursive = componentsUtil.c_;
var addComponentRootToKeyedElements = componentsUtil._V_;
var normalizeComponentKey = componentsUtil.ar_;
var VElement = require('/marko$4.16.3/dist/runtime/vdom/vdom'/*"../runtime/vdom/vdom"*/).ay_;
var virtualizeElement = VElement.az_;
var morphAttrs = VElement.aA_;
var eventDelegation = require('/marko$4.16.3/dist/components/event-delegation'/*"../components/event-delegation"*/);
var fragment = require('/marko$4.16.3/dist/morphdom/fragment'/*"./fragment"*/);
var helpers = require('/marko$4.16.3/dist/morphdom/helpers'/*"./helpers"*/);
var domData = require('/marko$4.16.3/dist/components/dom-data'/*"../components/dom-data"*/);
var keysByDOMNode = domData._M_;
var componentByDOMNode = domData.d_;
var vElementByDOMNode = domData._K_;
var detachedByDOMNode = domData._L_;

var insertBefore = helpers.as_;
var insertAfter = helpers.av_;
var nextSibling = helpers.aw_;
var firstChild = helpers.S_;
var removeChild = helpers.ax_;
var createFragmentNode = fragment._U_;
var beginFragmentNode = fragment.au_;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var COMPONENT_NODE = 2;
var FRAGMENT_NODE = 12;

// var FLAG_IS_SVG = 1;
// var FLAG_IS_TEXTAREA = 2;
// var FLAG_SIMPLE_ATTRS = 4;
var FLAG_PRESERVE = 8;
// var FLAG_CUSTOM_ELEMENT = 16;

function isAutoKey(key) {
    return !/^@/.test(key);
}

function compareNodeNames(fromEl, toEl) {
    return fromEl.aB_ === toEl.aB_;
}

function onNodeAdded(node, componentsContext) {
    if (node.nodeType === 1) {
        eventDelegation._I_(node, componentsContext);
    }
}

function morphdom(fromNode, toNode, doc, componentsContext) {
    var globalComponentsContext;
    var isRerenderInBrowser = false;
    var keySequences = {};

    if (componentsContext) {
        globalComponentsContext = componentsContext.O_;
        isRerenderInBrowser = globalComponentsContext.Q_;
    }

    function insertVirtualNodeBefore(vNode, key, referenceEl, parentEl, ownerComponent, parentComponent) {
        var realNode = vNode.aC_(doc);
        insertBefore(realNode, referenceEl, parentEl);

        if (vNode.aD_ === ELEMENT_NODE || vNode.aD_ === FRAGMENT_NODE) {
            if (key) {
                keysByDOMNode.set(realNode, key);
                (isAutoKey(key) ? parentComponent : ownerComponent).v_[key] = realNode;
            }

            morphChildren(realNode, vNode, parentComponent);
        }

        onNodeAdded(realNode, componentsContext);
    }

    function insertVirtualComponentBefore(vComponent, referenceNode, referenceNodeParentEl, component, key, ownerComponent, parentComponent) {
        var rootNode = component.h_ = insertBefore(createFragmentNode(), referenceNode, referenceNodeParentEl);
        componentByDOMNode.set(rootNode, component);

        if (key && ownerComponent) {
            key = normalizeComponentKey(key, parentComponent.id);
            addComponentRootToKeyedElements(ownerComponent.v_, key, rootNode, component.id);
            keysByDOMNode.set(rootNode, key);
        }

        morphComponent(component, vComponent);
    }

    function morphComponent(component, vComponent) {
        morphChildren(component.h_, vComponent, component);
    }

    var detachedNodes = [];

    function detachNode(node, parentNode, ownerComponent) {
        if (node.nodeType === ELEMENT_NODE || node.nodeType === FRAGMENT_NODE) {
            detachedNodes.push(node);
            detachedByDOMNode.set(node, ownerComponent || true);
        } else {
            destroyNodeRecursive(node);
            removeChild(node);
        }
    }

    function destroyComponent(component) {
        component.destroy();
    }

    function morphChildren(fromNode, toNode, parentComponent) {
        var curFromNodeChild = firstChild(fromNode);
        var curToNodeChild = toNode.S_;

        var curToNodeKey;
        var curFromNodeKey;
        var curToNodeType;

        var fromNextSibling;
        var toNextSibling;
        var matchingFromEl;
        var matchingFromComponent;
        var curVFromNodeChild;
        var fromComponent;

        outer: while (curToNodeChild) {
            toNextSibling = curToNodeChild.aw_;
            curToNodeType = curToNodeChild.aD_;
            curToNodeKey = curToNodeChild.aE_;

            var ownerComponent = curToNodeChild.aF_ || parentComponent;
            var referenceComponent;

            if (curToNodeType === COMPONENT_NODE) {
                var component = curToNodeChild._b_;
                if ((matchingFromComponent = existingComponentLookup[component.id]) === undefined) {
                    if (isRerenderInBrowser === true) {
                        var rootNode = beginFragmentNode(curFromNodeChild, fromNode);
                        component.h_ = rootNode;
                        componentByDOMNode.set(rootNode, component);

                        if (ownerComponent && curToNodeKey) {
                            curToNodeKey = normalizeComponentKey(curToNodeKey, parentComponent.id);
                            addComponentRootToKeyedElements(ownerComponent.v_, curToNodeKey, rootNode, component.id);

                            keysByDOMNode.set(rootNode, curToNodeKey);
                        }

                        morphComponent(component, curToNodeChild);

                        curFromNodeChild = nextSibling(rootNode);
                    } else {
                        insertVirtualComponentBefore(curToNodeChild, curFromNodeChild, fromNode, component, curToNodeKey, ownerComponent, parentComponent);
                    }
                } else {
                    if (matchingFromComponent.h_ !== curFromNodeChild) {
                        if (curFromNodeChild && (fromComponent = componentByDOMNode.get(curFromNodeChild)) && globalComponentsContext._z_[fromComponent.id] === undefined) {
                            // The component associated with the current real DOM node was not rendered
                            // so we should just remove it out of the real DOM by destroying it
                            curFromNodeChild = nextSibling(fromComponent.h_);
                            destroyComponent(fromComponent);
                            continue;
                        }

                        // We need to move the existing component into
                        // the correct location
                        insertBefore(matchingFromComponent.h_, curFromNodeChild, fromNode);
                    } else {
                        curFromNodeChild = curFromNodeChild && nextSibling(curFromNodeChild);
                    }

                    if (!curToNodeChild.aG_) {
                        morphComponent(component, curToNodeChild);
                    }
                }

                curToNodeChild = toNextSibling;
                continue;
            } else if (curToNodeKey) {
                curVFromNodeChild = undefined;
                curFromNodeKey = undefined;
                var curToNodeKeyOriginal = curToNodeKey;

                if (isAutoKey(curToNodeKey)) {
                    if (ownerComponent !== parentComponent) {
                        curToNodeKey += ":" + ownerComponent.id;
                    }
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent = ownerComponent;
                }

                var keySequence = keySequences[referenceComponent.id] || (keySequences[referenceComponent.id] = globalComponentsContext._A_());

                // We have a keyed element. This is the fast path for matching
                // up elements
                curToNodeKey = keySequence._i_(curToNodeKey);

                if (curFromNodeChild) {
                    curFromNodeKey = keysByDOMNode.get(curFromNodeChild);
                    curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
                    fromNextSibling = nextSibling(curFromNodeChild);
                }

                if (curFromNodeKey === curToNodeKey) {
                    // Elements line up. Now we just have to make sure they are compatible
                    if ((curToNodeChild._f_ & FLAG_PRESERVE) === 0 && !curToNodeChild.aG_) {
                        // We just skip over the fromNode if it is preserved

                        if (compareNodeNames(curToNodeChild, curVFromNodeChild)) {
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                        } else {
                            // Remove the old node
                            detachNode(curFromNodeChild, fromNode, ownerComponent);

                            // Incompatible nodes. Just move the target VNode into the DOM at this position
                            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                        }
                    } else {
                        // this should be preserved.
                    }
                } else {
                    if ((matchingFromEl = referenceComponent.v_[curToNodeKey]) === undefined) {
                        if (isRerenderInBrowser === true && curFromNodeChild) {
                            if (curFromNodeChild.nodeType === ELEMENT_NODE && curFromNodeChild.nodeName === curToNodeChild.aB_) {
                                curVFromNodeChild = virtualizeElement(curFromNodeChild);
                                keysByDOMNode.set(curFromNodeChild, curToNodeKey);
                                morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                                curToNodeChild = toNextSibling;
                                curFromNodeChild = fromNextSibling;
                                continue;
                            } else if (curToNodeChild.aD_ === FRAGMENT_NODE && curFromNodeChild.nodeType === COMMENT_NODE) {
                                var content = curFromNodeChild.nodeValue;
                                if (content == "F#" + curToNodeKeyOriginal) {
                                    var endNode = curFromNodeChild.nextSibling;
                                    var depth = 0;
                                    var nodeValue;

                                    // eslint-disable-next-line no-constant-condition
                                    while (true) {
                                        if (endNode.nodeType === COMMENT_NODE) {
                                            nodeValue = endNode.nodeValue;
                                            if (nodeValue === "F/") {
                                                if (depth === 0) {
                                                    break;
                                                } else {
                                                    depth--;
                                                }
                                            } else if (nodeValue.indexOf("F#") === 0) {
                                                depth++;
                                            }
                                        }
                                        endNode = endNode.nextSibling;
                                    }

                                    var fragment = createFragmentNode(curFromNodeChild, endNode.nextSibling, fromNode);
                                    keysByDOMNode.set(fragment, curToNodeKey);
                                    vElementByDOMNode.set(fragment, curToNodeChild);
                                    referenceComponent.v_[curToNodeKey] = fragment;
                                    removeChild(curFromNodeChild);
                                    removeChild(endNode);

                                    if (!curToNodeChild.aG_) {
                                        morphChildren(fragment, curToNodeChild, parentComponent);
                                    }

                                    curToNodeChild = toNextSibling;
                                    curFromNodeChild = fragment.nextSibling;
                                    continue;
                                }
                            }
                        }

                        insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                        fromNextSibling = curFromNodeChild;
                    } else {
                        if (detachedByDOMNode.get(matchingFromEl) !== undefined) {
                            detachedByDOMNode.set(matchingFromEl, undefined);
                        }

                        if ((curToNodeChild._f_ & FLAG_PRESERVE) === 0 && !curToNodeChild.aG_) {
                            curVFromNodeChild = vElementByDOMNode.get(matchingFromEl);

                            if (compareNodeNames(curVFromNodeChild, curToNodeChild)) {
                                if (fromNextSibling === matchingFromEl) {
                                    // Single element removal:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     D
                                    // D
                                    //
                                    // Single element swap:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     B

                                    if (toNextSibling && toNextSibling.aE_ === curFromNodeKey) {
                                        // Single element swap

                                        // We want to stay on the current real DOM node
                                        fromNextSibling = curFromNodeChild;

                                        // But move the matching element into place
                                        insertBefore(matchingFromEl, curFromNodeChild, fromNode);
                                    } else {
                                        // Single element removal

                                        // We need to remove the current real DOM node
                                        // and the matching real DOM node will fall into
                                        // place. We will continue diffing with next sibling
                                        // after the real DOM node that just fell into place
                                        fromNextSibling = nextSibling(fromNextSibling);

                                        if (curFromNodeChild) {
                                            detachNode(curFromNodeChild, fromNode, ownerComponent);
                                        }
                                    }
                                } else {
                                    // A <-> A
                                    // B <-> D <-- We are here
                                    // C
                                    // D

                                    // We need to move the matching node into place
                                    insertAfter(matchingFromEl, curFromNodeChild, fromNode);

                                    if (curFromNodeChild) {
                                        detachNode(curFromNodeChild, fromNode, ownerComponent);
                                    }
                                }

                                if ((curToNodeChild._f_ & FLAG_PRESERVE) === 0) {
                                    morphEl(matchingFromEl, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                                }
                            } else {
                                insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                                detachNode(matchingFromEl, fromNode, ownerComponent);
                            }
                        } else {
                            // preserve the node
                            // but still we need to diff the current from node
                            insertBefore(matchingFromEl, curFromNodeChild, fromNode);
                            fromNextSibling = curFromNodeChild;
                        }
                    }
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
                continue;
            }

            // The know the target node is not a VComponent node and we know
            // it is also not a preserve node. Let's now match up the HTML
            // element, text node, comment, etc.
            while (curFromNodeChild) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
                    // The current "to" element is not associated with a component,
                    // but the current "from" element is associated with a component

                    // Even if we destroy the current component in the original
                    // DOM or not, we still need to skip over it since it is
                    // not compatible with the current "to" node
                    curFromNodeChild = fromNextSibling;

                    if (!globalComponentsContext._z_[fromComponent.id]) {
                        destroyComponent(fromComponent);
                    }

                    continue; // Move to the next "from" node
                }

                var curFromNodeType = curFromNodeChild.nodeType;

                var isCompatible = undefined;

                if (curFromNodeType === curToNodeType) {
                    if (curFromNodeType === ELEMENT_NODE) {
                        // Both nodes being compared are Element nodes
                        curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
                        if (curVFromNodeChild === undefined) {
                            if (isRerenderInBrowser === true) {
                                curVFromNodeChild = virtualizeElement(curFromNodeChild);
                            } else {
                                // Skip over nodes that don't look like ours...
                                curFromNodeChild = fromNextSibling;
                                continue;
                            }
                        } else if (curFromNodeKey = curVFromNodeChild.aE_) {
                            // We have a keyed element here but our target VDOM node
                            // is not keyed so this not doesn't belong
                            isCompatible = false;
                        }

                        isCompatible = isCompatible !== false && compareNodeNames(curVFromNodeChild, curToNodeChild) === true;

                        if (isCompatible === true) {
                            // We found compatible DOM elements so transform
                            // the current "from" node to match the current
                            // target DOM node.
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                        }
                    } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
                        // Both nodes being compared are Text or Comment nodes
                        isCompatible = true;
                        // Simply update nodeValue on the original node to
                        // change the text value
                        if (curFromNodeChild.nodeValue !== curToNodeChild.aH_) {
                            curFromNodeChild.nodeValue = curToNodeChild.aH_;
                        }
                    }
                }

                if (isCompatible === true) {
                    // Advance both the "to" child and the "from" child since we found a match
                    curToNodeChild = toNextSibling;
                    curFromNodeChild = fromNextSibling;
                    continue outer;
                }

                if (curFromNodeKey) {
                    if (globalComponentsContext._x_[curFromNodeKey] === undefined) {
                        detachNode(curFromNodeChild, fromNode, ownerComponent);
                    }
                } else {
                    detachNode(curFromNodeChild, fromNode, ownerComponent);
                }

                curFromNodeChild = fromNextSibling;
            } // END: while (curFromNodeChild)

            // If we got this far then we did not find a candidate match for
            // our "to node" and we exhausted all of the children "from"
            // nodes. Therefore, we will just append the current "to" node
            // to the end
            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);

            curToNodeChild = toNextSibling;
            curFromNodeChild = fromNextSibling;
        }

        // We have processed all of the "to nodes".
        if (fromNode.at_) {
            // If we are in an unfinished fragment, we have reached the end of the nodes
            // we were matching up and need to end the fragment
            fromNode.at_(curFromNodeChild);
        } else {
            // If curFromNodeChild is non-null then we still have some from nodes
            // left over that need to be removed
            while (curFromNodeChild) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
                    curFromNodeChild = fromNextSibling;
                    if (!globalComponentsContext._z_[fromComponent.id]) {
                        destroyComponent(fromComponent);
                    }
                    continue;
                }

                curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);

                // For transcluded content, we need to check if the element belongs to a different component
                // context than the current component and ensure it gets removed from its key index.
                if (isAutoKey(keysByDOMNode.get(fromNode))) {
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent = curVFromNodeChild && curVFromNodeChild.aF_;
                }

                detachNode(curFromNodeChild, fromNode, referenceComponent);

                curFromNodeChild = fromNextSibling;
            }
        }
    }

    function morphEl(fromEl, vFromEl, toEl, toElKey, ownerComponent, parentComponent) {
        var nodeName = toEl.aB_;

        if (isRerenderInBrowser === true && toElKey) {
            ownerComponent.v_[toElKey] = fromEl;
        }

        var constId = toEl.aI_;
        if (constId !== undefined && vFromEl.aI_ === constId) {
            return;
        }

        morphAttrs(fromEl, vFromEl, toEl);

        if (toElKey && globalComponentsContext._y_[toElKey] === true) {
            // Don't morph the children since they are preserved
            return;
        }

        if (nodeName !== "TEXTAREA") {
            morphChildren(fromEl, toEl, parentComponent);
        }

        var specialElHandler = specialElHandlers[nodeName];
        if (specialElHandler !== undefined) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    morphChildren(fromNode, toNode, toNode._b_);

    detachedNodes.forEach(function (node) {
        var detachedFromComponent = detachedByDOMNode.get(node);

        if (detachedFromComponent !== undefined) {
            detachedByDOMNode.set(node, undefined);

            var componentToDestroy = componentByDOMNode.get(node);
            if (componentToDestroy) {
                componentToDestroy.destroy();
            } else if (node.parentNode) {
                destroyNodeRecursive(node, detachedFromComponent !== true && detachedFromComponent);

                if (eventDelegation.z_(node) != false) {
                    removeChild(node);
                }
            }
        }
    });
}

module.exports = morphdom;
});
$_mod.def("/marko$4.16.3/dist/components/Component", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var complain;

var domInsert = require('/marko$4.16.3/dist/runtime/dom-insert'/*"../runtime/dom-insert"*/);
var defaultCreateOut = require('/marko$4.16.3/dist/runtime/createOut'/*"../runtime/createOut"*/);
var getComponentsContext = require('/marko$4.16.3/dist/components/ComponentsContext'/*"./ComponentsContext"*/).__;
var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.a_;
var emitLifecycleEvent = componentsUtil.b_;
var destroyNodeRecursive = componentsUtil.c_;
var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var RenderResult = require('/marko$4.16.3/dist/runtime/RenderResult'/*"../runtime/RenderResult"*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*"listener-tracker"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var updateManager = require('/marko$4.16.3/dist/components/update-manager'/*"./update-manager"*/);
var morphdom = require('/marko$4.16.3/dist/morphdom/index'/*"../morphdom"*/);
var eventDelegation = require('/marko$4.16.3/dist/components/event-delegation'/*"./event-delegation"*/);
var domData = require('/marko$4.16.3/dist/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.d_;
var CONTEXT_KEY = "__subtree_context__";

var slice = Array.prototype.slice;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};

var emit = EventEmitter.prototype.emit;
var ELEMENT_NODE = 1;

function removeListener(removeEventListenerHandle) {
    removeEventListenerHandle();
}

function handleCustomEventWithMethodListener(component, targetMethodName, args, extraArgs) {
    // Remove the "eventType" argument
    args.push(component);

    if (extraArgs) {
        args = extraArgs.concat(args);
    }

    var targetComponent = componentLookup[component.e_];
    var targetMethod = typeof targetMethodName === "function" ? targetMethodName : targetComponent[targetMethodName];
    if (!targetMethod) {
        throw Error("Method not found: " + targetMethodName);
    }

    targetMethod.apply(targetComponent, args);
}

function resolveKeyHelper(key, index) {
    return index ? key + "_" + index : key;
}

function resolveComponentIdHelper(component, key, index) {
    return component.id + "-" + resolveKeyHelper(key, index);
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
    var handlerMethod;
    var handlers;

    for (var propName in stateChanges) {
        if (stateChanges.hasOwnProperty(propName)) {
            var handlerMethodName = "update_" + propName;

            handlerMethod = component[handlerMethodName];
            if (handlerMethod) {
                (handlers || (handlers = [])).push([propName, handlerMethod]);
            } else {
                // This state change does not have a state handler so return false
                // to force a rerender
                return;
            }
        }
    }

    // If we got here then all of the changed state properties have
    // an update handler or there are no state properties that actually
    // changed.
    if (handlers) {
        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        handlers.forEach(function (handler) {
            var propertyName = handler[0];
            handlerMethod = handler[1];

            var newValue = stateChanges[propertyName];
            var oldValue = oldState[propertyName];
            handlerMethod.call(component, newValue, oldValue);
        });

        emitLifecycleEvent(component, "update");

        component.f_();
    }

    return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
    if (oldInput != newInput) {
        if (oldInput == null || newInput == null) {
            return true;
        }

        var oldKeys = Object.keys(oldInput);
        var newKeys = Object.keys(newInput);
        var len = oldKeys.length;
        if (len !== newKeys.length) {
            return true;
        }

        for (var i = 0; i < len; i++) {
            var key = oldKeys[i];
            if (oldInput[key] !== newInput[key]) {
                return true;
            }
        }
    }

    return false;
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
    EventEmitter.call(this);
    this.id = id;
    this.g_ = null;
    this.h_ = null;
    this.i_ = null;
    this.j_ = null;
    this.k_ = null; // Used to keep track of bubbling DOM events for components rendered on the server
    this.l_ = null;
    this.e_ = null;
    this.m_ = null;
    this.n_ = undefined;
    this.o_ = false;
    this.p_ = undefined;

    this.q_ = false;
    this.r_ = false;
    this.s_ = false;
    this.t_ = false;

    this.u_ = undefined;

    this.v_ = {};
    this.w_ = undefined;
}

Component.prototype = componentProto = {
    x_: true,

    subscribeTo: function (target) {
        if (!target) {
            throw TypeError();
        }

        var subscriptions = this.i_ || (this.i_ = new SubscriptionTracker());

        var subscribeToOptions = target.x_ ? COMPONENT_SUBSCRIBE_TO_OPTIONS : NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

        return subscriptions.subscribeTo(target, subscribeToOptions);
    },

    emit: function (eventType) {
        var customEvents = this.l_;
        var target;

        if (customEvents && (target = customEvents[eventType])) {
            var targetMethodName = target[0];
            var isOnce = target[1];
            var extraArgs = target[2];
            var args = slice.call(arguments, 1);

            handleCustomEventWithMethodListener(this, targetMethodName, args, extraArgs);

            if (isOnce) {
                delete customEvents[eventType];
            }
        }

        if (this.listenerCount(eventType)) {
            return emit.apply(this, arguments);
        }
    },
    getElId: function (key, index) {
        return resolveComponentIdHelper(this, key, index);
    },
    getEl: function (key, index) {
        if (key) {
            var resolvedKey = resolveKeyHelper(key, index);
            var keyedElement = this.v_["@" + resolvedKey];

            if (!keyedElement) {
                var keyedComponent = this.getComponent(resolvedKey);

                if (keyedComponent) {
                    return keyedComponent.h_.firstChild;
                    // eslint-disable-next-line no-constant-condition
                }
            }

            return keyedElement;
        } else {
            return this.el;
        }
    },
    getEls: function (key) {
        key = key + "[]";

        var els = [];
        var i = 0;
        var el;
        while (el = this.getEl(key, i)) {
            els.push(el);
            i++;
        }
        return els;
    },
    getComponent: function (key, index) {
        var rootNode = this.v_[resolveKeyHelper(key, index)];
        if (/\[\]$/.test(key)) {
            rootNode = rootNode && rootNode[Object.keys(rootNode)[0]];
            // eslint-disable-next-line no-constant-condition
        }
        return rootNode && componentsByDOMNode.get(rootNode);
    },
    getComponents: function (key) {
        var lookup = this.v_[key + "[]"];
        return lookup ? Object.keys(lookup).map(function (key) {
            return componentsByDOMNode.get(lookup[key]);
        }) : [];
    },
    destroy: function () {
        if (this.q_) {
            return;
        }

        var root = this.h_;
        var nodes = this.h_.nodes;

        this.y_();

        nodes.forEach(function (node) {
            destroyNodeRecursive(node);

            if (eventDelegation.z_(node) !== false) {
                node.parentNode.removeChild(node);
            }
        });

        root.detached = true;

        delete componentLookup[this.id];
        this.v_ = {};
    },

    y_: function () {
        if (this.q_) {
            return;
        }

        emitLifecycleEvent(this, "destroy");
        this.q_ = true;

        componentsByDOMNode.set(this.h_, undefined);

        this.h_ = null;

        // Unsubscribe from all DOM events
        this.A_();

        var subscriptions = this.i_;
        if (subscriptions) {
            subscriptions.removeAllListeners();
            this.i_ = null;
        }
    },

    isDestroyed: function () {
        return this.q_;
    },
    get state() {
        return this.g_;
    },
    set state(newState) {
        var state = this.g_;
        if (!state && !newState) {
            return;
        }

        if (!state) {
            state = this.g_ = new this.B_(this);
        }

        state.C_(newState || {});

        if (state.s_) {
            this.D_();
        }

        if (!newState) {
            this.g_ = null;
        }
    },
    setState: function (name, value) {
        var state = this.g_;

        if (typeof name == "object") {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    state.E_(k, newState[k], true /* ensure:true */);
                }
            }
        } else {
            state.E_(name, value, true /* ensure:true */);
        }
    },

    setStateDirty: function (name, value) {
        var state = this.g_;

        if (arguments.length == 1) {
            value = state[name];
        }

        state.E_(name, value, true /* ensure:true */
        , true /* forceDirty:true */
        );
    },

    replaceState: function (newState) {
        this.g_.C_(newState);
    },

    get input() {
        return this.n_;
    },
    set input(newInput) {
        if (this.t_) {
            this.n_ = newInput;
        } else {
            this.F_(newInput);
        }
    },

    F_: function (newInput, onInput, out) {
        onInput = onInput || this.onInput;
        var updatedInput;

        var oldInput = this.n_;
        this.n_ = undefined;
        this.G_ = out && out[CONTEXT_KEY] || this.G_;

        if (onInput) {
            // We need to set a flag to preview `this.input = foo` inside
            // onInput causing infinite recursion
            this.t_ = true;
            updatedInput = onInput.call(this, newInput || {}, out);
            this.t_ = false;
        }

        newInput = this.m_ = updatedInput || newInput;

        if (this.s_ = checkInputChanged(this, oldInput, newInput)) {
            this.D_();
        }

        if (this.n_ === undefined) {
            this.n_ = newInput;
            if (newInput && newInput.$global) {
                this.p_ = newInput.$global;
            }
        }

        return newInput;
    },

    forceUpdate: function () {
        this.s_ = true;
        this.D_();
    },

    D_: function () {
        if (!this.r_) {
            this.r_ = true;
            updateManager.H_(this);
        }
    },

    update: function () {
        if (this.q_ === true || this.I_ === false) {
            return;
        }

        var input = this.n_;
        var state = this.g_;

        if (this.s_ === false && state !== null && state.s_ === true) {
            if (processUpdateHandlers(this, state.J_, state.K_, state)) {
                state.s_ = false;
            }
        }

        if (this.I_ === true) {
            // The UI component is still dirty after process state handlers
            // then we should rerender

            if (this.shouldUpdate(input, state) !== false) {
                this.L_(false);
            }
        }

        this.f_();
    },

    get I_() {
        return this.s_ === true || this.g_ !== null && this.g_.s_ === true;
    },

    f_: function () {
        this.s_ = false;
        this.r_ = false;
        this.m_ = null;
        var state = this.g_;
        if (state) {
            state.f_();
        }
    },

    shouldUpdate: function () {
        return true;
    },

    b_: function (eventType, eventArg1, eventArg2) {
        emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
    },

    L_: function (isRerenderInBrowser) {
        var self = this;
        var renderer = self.M_;

        if (!renderer) {
            throw TypeError();
        }

        var rootNode = this.h_;

        var doc = self.u_;
        var input = this.m_ || this.n_;
        var globalData = this.p_;

        updateManager.N_(function () {
            var createOut = renderer.createOut || defaultCreateOut;
            var out = createOut(globalData);
            out.sync();
            out.u_ = self.u_;
            out[CONTEXT_KEY] = self.G_;

            var componentsContext = getComponentsContext(out);
            var globalComponentsContext = componentsContext.O_;
            globalComponentsContext.P_ = self;
            globalComponentsContext.Q_ = isRerenderInBrowser;

            renderer(input, out);

            var result = new RenderResult(out);

            var targetNode = out.R_().S_;

            morphdom(rootNode, targetNode, doc, componentsContext);

            result.afterInsert(doc);
        });

        this.f_();
    },

    T_: function () {
        var root = this.h_;
        root.remove();
        return root;
    },

    A_: function () {
        var eventListenerHandles = this.j_;
        if (eventListenerHandles) {
            eventListenerHandles.forEach(removeListener);
            this.j_ = null;
        }
    },

    get U_() {
        var state = this.g_;
        return state && state.V_;
    },

    W_: function (customEvents, scope) {
        var finalCustomEvents = this.l_ = {};
        this.e_ = scope;

        customEvents.forEach(function (customEvent) {
            var eventType = customEvent[0];
            var targetMethodName = customEvent[1];
            var isOnce = customEvent[2];
            var extraArgs = customEvent[3];

            finalCustomEvents[eventType] = [targetMethodName, isOnce, extraArgs];
        });
    },

    get el() {
        return this.h_ && this.h_.firstChild;
        // eslint-disable-next-line no-constant-condition
    },

    get els() {
        return (this.h_ ? this.h_.nodes : []).filter(function (el) {
            return el.nodeType === ELEMENT_NODE;
        });
        // eslint-disable-next-line no-constant-condition
    }
};

componentProto.elId = componentProto.getElId;
componentProto.X_ = componentProto.update;
componentProto.Y_ = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(componentProto, function getEl(component) {
    return component.T_();
}, function afterInsert(component) {
    return component;
});

inherit(Component, EventEmitter);

module.exports = Component;
});
$_mod.def("/marko$4.16.3/dist/components/defineComponent", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var BaseState = require('/marko$4.16.3/dist/components/State'/*"./State"*/);
var BaseComponent = require('/marko$4.16.3/dist/components/Component'/*"./Component"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

module.exports = function defineComponent(def, renderer) {
    if (def.x_) {
        return def;
    }

    var ComponentClass = function () {};
    var proto;

    var type = typeof def;

    if (type == "function") {
        proto = def.prototype;
    } else if (type == "object") {
        proto = def;
    } else {
        throw TypeError();
    }

    ComponentClass.prototype = proto;

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initComponent"
    // property and that method gets called later inside
    // init-components-browser.js
    function Component(id) {
        BaseComponent.call(this, id);
    }

    if (!proto.x_) {
        // Inherit from Component if they didn't already
        inherit(ComponentClass, BaseComponent);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Component.prototype = ComponentClass.prototype;

    // proto.constructor = def.constructor = Component;

    // Set a flag on the constructor function to make it clear this is
    // a component so that we can short-circuit this work later
    Component.x_ = true;

    function State(component) {
        BaseState.call(this, component);
    }
    inherit(State, BaseState);
    proto.B_ = State;
    proto.M_ = renderer;

    return Component;
};
});
$_mod.main("/marko$4.16.3/dist/loader", "");
$_mod.remap("/marko$4.16.3/dist/loader/index", "/marko$4.16.3/dist/loader/index-browser");
$_mod.remap("/marko$4.16.3/dist/loader/index-browser", "/marko$4.16.3/dist/loader/index-browser-dynamic");
$_mod.def("/marko$4.16.3/dist/loader/index-browser-dynamic", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$_mod.def("/marko$4.16.3/dist/components/registry-browser", function(require, exports, module, __filename, __dirname) { var complain;
var defineComponent = require('/marko$4.16.3/dist/components/defineComponent'/*"./defineComponent"*/);
var loader = require('/marko$4.16.3/dist/loader/index-browser-dynamic'/*"../loader"*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(componentId, def) {
    registered[componentId] = def;
    delete loaded[componentId];
    delete componentTypes[componentId];
    return componentId;
}

function load(typeName, isLegacy) {
    var target = loaded[typeName];
    if (!target) {
        target = registered[typeName];

        if (target) {
            target = target();
        } else if (isLegacy) {
            target = window.$markoLegacy.load(typeName);
        } else {
            target = loader(typeName);
            // eslint-disable-next-line no-constant-condition
        }

        if (!target) {
            throw Error("Component not found: " + typeName);
        }

        loaded[typeName] = target;
    }

    return target;
}

function getComponentClass(typeName, isLegacy) {
    var ComponentClass = componentTypes[typeName];

    if (ComponentClass) {
        return ComponentClass;
    }

    ComponentClass = load(typeName, isLegacy);

    ComponentClass = ComponentClass.Component || ComponentClass;

    if (!ComponentClass.x_) {
        ComponentClass = defineComponent(ComponentClass, ComponentClass.renderer);
    }

    // Make the component "type" accessible on each component instance
    ComponentClass.prototype._l_ = typeName;

    // eslint-disable-next-line no-constant-condition


    componentTypes[typeName] = ComponentClass;

    return ComponentClass;
}

function createComponent(typeName, id, isLegacy) {
    var ComponentClass = getComponentClass(typeName, isLegacy);
    return new ComponentClass(id);
}

exports._Q_ = register;
exports._n_ = createComponent;
});
$_mod.def("/marko$4.16.3/dist/components/init-components-browser", function(require, exports, module, __filename, __dirname) { "use strict";

var warp10Finalize = require('/warp10$2.0.1/finalize'/*"warp10/finalize"*/);
var eventDelegation = require('/marko$4.16.3/dist/components/event-delegation'/*"./event-delegation"*/);
var win = window;
var defaultDocument = document;
var createFragmentNode = require('/marko$4.16.3/dist/morphdom/fragment'/*"../morphdom/fragment"*/)._U_;
var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.a_;
var addComponentRootToKeyedElements = componentsUtil._V_;
var ComponentDef = require('/marko$4.16.3/dist/components/ComponentDef'/*"./ComponentDef"*/);
var registry = require('/marko$4.16.3/dist/components/registry-browser'/*"./registry"*/);
var domData = require('/marko$4.16.3/dist/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.d_;
var serverRenderedGlobals = {};
var serverComponentRootNodes = {};
var keyedElementsByComponentId = {};

var FLAG_WILL_RERENDER_IN_BROWSER = 1;

function indexServerComponentBoundaries(node, runtimeId, stack) {
    var componentId;
    var ownerId;
    var ownerComponent;
    var keyedElements;
    var nextSibling;
    var runtimeLength = runtimeId.length;
    stack = stack || [];

    node = node.firstChild;
    while (node) {
        nextSibling = node.nextSibling;
        if (node.nodeType === 8) {
            // Comment node
            var commentValue = node.nodeValue;
            if (commentValue.slice(0, runtimeLength) === runtimeId) {
                var firstChar = commentValue[runtimeLength];

                if (firstChar === "^" || firstChar === "#") {
                    stack.push(node);
                } else if (firstChar === "/") {
                    var endNode = node;
                    var startNode = stack.pop();
                    var rootNode;

                    if (startNode.parentNode === endNode.parentNode) {
                        rootNode = createFragmentNode(startNode.nextSibling, endNode);
                    } else {
                        rootNode = createFragmentNode(endNode.parentNode.firstChild, endNode);
                    }

                    componentId = startNode.nodeValue.substring(runtimeLength + 1);
                    firstChar = startNode.nodeValue[runtimeLength];

                    if (firstChar === "^") {
                        var parts = componentId.split(/ /g);
                        var key = parts[2];
                        ownerId = parts[1];
                        componentId = parts[0];
                        if (ownerComponent = componentLookup[ownerId]) {
                            keyedElements = ownerComponent.v_;
                        } else {
                            keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
                        }
                        addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId);
                    }

                    serverComponentRootNodes[componentId] = rootNode;

                    startNode.parentNode.removeChild(startNode);
                    endNode.parentNode.removeChild(endNode);
                }
            }
        } else if (node.nodeType === 1) {
            // HTML element node
            var markoKey = node.getAttribute("data-marko-key");
            var markoProps = node.getAttribute("data-marko");
            if (markoKey) {
                var separatorIndex = markoKey.indexOf(" ");
                ownerId = markoKey.substring(separatorIndex + 1);
                markoKey = markoKey.substring(0, separatorIndex);
                if (ownerComponent = componentLookup[ownerId]) {
                    keyedElements = ownerComponent.v_;
                } else {
                    keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
                }
                keyedElements[markoKey] = node;
            }
            if (markoProps) {
                markoProps = JSON.parse(markoProps);
                Object.keys(markoProps).forEach(function (key) {
                    if (key.slice(0, 2) === "on") {
                        eventDelegation.___(key.slice(2));
                    }
                });
            }
            indexServerComponentBoundaries(node, runtimeId, stack);
        }

        node = nextSibling;
    }
}

function invokeComponentEventHandler(component, targetMethodName, args) {
    var method = component[targetMethodName];
    if (!method) {
        throw Error("Method not found: " + targetMethodName);
    }

    method.apply(component, args);
}

function addEventListenerHelper(el, eventType, isOnce, listener) {
    var eventListener = listener;
    if (isOnce) {
        eventListener = function (event) {
            listener(event);
            el.removeEventListener(eventType, eventListener);
        };
    }

    el.addEventListener(eventType, eventListener, false);

    return function remove() {
        el.removeEventListener(eventType, eventListener);
    };
}

function addDOMEventListeners(component, el, eventType, targetMethodName, isOnce, extraArgs, handles) {
    var removeListener = addEventListenerHelper(el, eventType, isOnce, function (event) {
        var args = [event, el];
        if (extraArgs) {
            args = extraArgs.concat(args);
        }

        invokeComponentEventHandler(component, targetMethodName, args);
    });
    handles.push(removeListener);
}

function initComponent(componentDef, doc) {
    var component = componentDef._b_;

    if (!component || !component.x_) {
        return; // legacy
    }

    component.f_();
    component.u_ = doc;

    var isExisting = componentDef._d_;
    var id = component.id;

    componentLookup[id] = component;

    if (componentDef._f_ & FLAG_WILL_RERENDER_IN_BROWSER) {
        component.L_(true);
        return;
    }

    if (isExisting) {
        component.A_();
    }

    var domEvents = componentDef._c_;
    if (domEvents) {
        var eventListenerHandles = [];

        domEvents.forEach(function (domEventArgs) {
            // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

            var eventType = domEventArgs[0];
            var targetMethodName = domEventArgs[1];
            var eventEl = component.v_[domEventArgs[2]];
            var isOnce = domEventArgs[3];
            var extraArgs = domEventArgs[4];

            addDOMEventListeners(component, eventEl, eventType, targetMethodName, isOnce, extraArgs, eventListenerHandles);
        });

        if (eventListenerHandles.length) {
            component.j_ = eventListenerHandles;
        }
    }

    if (component.o_) {
        component.b_("update");
    } else {
        component.o_ = true;
        component.b_("mount");
    }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation._P_(doc);

    doc = doc || defaultDocument;
    for (var i = componentDefs.length - 1; i >= 0; i--) {
        var componentDef = componentDefs[i];
        initComponent(componentDef, doc);
    }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
    if (!renderedComponents) {
        renderedComponents = win.$components;

        if (renderedComponents && renderedComponents.forEach) {
            renderedComponents.forEach(function (renderedComponent) {
                initServerRendered(renderedComponent, doc);
            });
        }

        win.$components = {
            concat: initServerRendered
        };

        return;
    }

    doc = doc || defaultDocument;

    renderedComponents = warp10Finalize(renderedComponents);

    var componentDefs = renderedComponents.w;
    var typesArray = renderedComponents.t;
    var runtimeId = renderedComponents.r;

    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    indexServerComponentBoundaries(doc, runtimeId);
    eventDelegation._P_(doc);

    var globals = window.$MG;
    if (globals) {
        serverRenderedGlobals = warp10Finalize(globals);
        delete window.$MG;
    }

    componentDefs.forEach(function (componentDef) {
        componentDef = ComponentDef._m_(componentDef, typesArray, serverRenderedGlobals, registry);

        if (!hydrateComponent(componentDef, doc)) {
            // hydrateComponent will return false if there is not rootNode
            // for the component.  If this is the case, we'll wait until the
            // DOM has fully loaded to attempt to init the component again.
            doc.addEventListener("DOMContentLoaded", function () {
                if (!hydrateComponent(componentDef, doc)) {
                    indexServerComponentBoundaries(doc, runtimeId);
                    hydrateComponent(componentDef, doc);
                }
            });
        }
    });
}

function hydrateComponent(componentDef, doc) {
    var componentId = componentDef.id;
    var component = componentDef._b_;
    var rootNode = serverComponentRootNodes[componentId];

    if (rootNode) {
        delete serverComponentRootNodes[componentId];

        component.h_ = rootNode;
        componentsByDOMNode.set(rootNode, component);
        component.v_ = keyedElementsByComponentId[componentId] || {};

        delete keyedElementsByComponentId[componentId];

        initComponent(componentDef, doc || defaultDocument);
        return true;
    }
}

exports._u_ = initClientRendered;
exports._S_ = initServerRendered;
});
$_mod.def("/marko$4.16.3/dist/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var initComponents = require('/marko$4.16.3/dist/components/init-components-browser'/*"./init-components"*/);
var registry = require('/marko$4.16.3/dist/components/registry-browser'/*"./registry"*/);

require('/marko$4.16.3/dist/components/ComponentsContext'/*"./ComponentsContext"*/)._u_ = initComponents._u_;

exports.getComponentForEl = componentsUtil._R_;
exports.init = window.$initComponents = initComponents._S_;

exports.register = function (id, component) {
    registry._Q_(id, function () {
        return component;
    });
};
});
$_mod.def("/marko$4.16.3/components-browser.marko", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.16.3/dist/components/index-browser'/*"./dist/components"*/);

});
$_mod.main("/marko$4.16.3/dist/runtime/vdom", "");
$_mod.main("/marko$4.16.3/dist", "");
$_mod.remap("/marko$4.16.3/dist/index", "/marko$4.16.3/dist/index-browser");
$_mod.def("/marko$4.16.3/dist/index-browser", function(require, exports, module, __filename, __dirname) { "use strict";

exports.createOut = require('/marko$4.16.3/dist/runtime/createOut'/*"./runtime/createOut"*/);
exports.load = require('/marko$4.16.3/dist/loader/index-browser-dynamic'/*"./loader"*/);
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/helper-styleAttr", function(require, exports, module, __filename, __dirname) { var dashedNames = {};

/**
 * Helper for generating the string for a style attribute
 * @param  {[type]} style [description]
 * @return {[type]}       [description]
 */
module.exports = function styleHelper(style) {
    if (!style) {
        return null;
    }

    var type = typeof style;

    if (type !== "string") {
        var styles = "";

        if (Array.isArray(style)) {
            for (var i = 0, len = style.length; i < len; i++) {
                var next = styleHelper(style[i]);
                if (next) styles += next + (next[next.length - 1] !== ";" ? ";" : "");
            }
        } else if (type === "object") {
            for (var name in style) {
                var value = style[name];
                if (value != null) {
                    if (typeof value === "number" && value) {
                        value += "px";
                    }

                    var nameDashed = dashedNames[name];
                    if (!nameDashed) {
                        nameDashed = dashedNames[name] = name.replace(/([A-Z])/g, "-$1").toLowerCase();
                    }
                    styles += nameDashed + ":" + value + ";";
                }
            }
        }

        return styles || null;
    }

    return style;
};
});
$_mod.def("/marko$4.16.3/dist/compiler/util/removeDashes", function(require, exports, module, __filename, __dirname) { module.exports = function removeDashes(str) {
    return str.replace(/-([a-z])/g, function (match, lower) {
        return lower.toUpperCase();
    });
};
});
$_mod.def("/warp10$2.0.1/constants", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$2.0.1/src/constants'/*"./src/constants"*/);
});
$_mod.def("/marko$4.16.3/dist/runtime/helpers", function(require, exports, module, __filename, __dirname) { "use strict";

var complain;
var removeDashes = require('/marko$4.16.3/dist/compiler/util/removeDashes'/*"../compiler/util/removeDashes"*/);
var ComponentsContext = require('/marko$4.16.3/dist/components/ComponentsContext'/*"../components/ComponentsContext"*/);
var getComponentsContext = ComponentsContext.__;
var ComponentDef = require('/marko$4.16.3/dist/components/ComponentDef'/*"../components/ComponentDef"*/);
var w10NOOP = require('/warp10$2.0.1/constants'/*"warp10/constants"*/).NOOP;
var isArray = Array.isArray;
var RENDER_BODY_TO_JSON = function () {
    return w10NOOP;
};
var FLAG_WILL_RERENDER_IN_BROWSER = 1;
var IS_SERVER = typeof window === "undefined";

function isFunction(arg) {
    return typeof arg == "function";
}

function classList(arg, classNames) {
    var len;

    if (arg) {
        if (typeof arg == "string") {
            if (arg) {
                classNames.push(arg);
            }
        } else if (typeof (len = arg.length) == "number") {
            for (var i = 0; i < len; i++) {
                classList(arg[i], classNames);
            }
        } else if (typeof arg == "object") {
            for (var name in arg) {
                if (arg.hasOwnProperty(name)) {
                    var value = arg[name];
                    if (value) {
                        classNames.push(name);
                    }
                }
            }
        }
    }
}

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function (input, out) {
        var rendererFunc = handler.renderer || handler._ || handler.render;
        if (!isFunction(rendererFunc)) {
            throw Error("Invalid renderer");
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer || handler._;

    if (renderer) {
        return renderer;
    }

    if (isFunction(handler)) {
        return handler;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

var helpers = {
    /**
     * Internal helper method to prevent null/undefined from being written out
     * when writing text that resolves to null/undefined
     * @private
     */
    s: function strHelper(str) {
        return str == null ? "" : str.toString();
    },

    /**
     * Internal helper method to handle loops without a status variable
     * @private
     */
    f: function forEachHelper(array, callback) {
        var i;

        if (array == null) {} else if (isArray(array)) {
            for (i = 0; i < array.length; i++) {
                callback(array[i], i, array);
            }
            // eslint-disable-next-line no-constant-condition
        } else if (typeof array.forEach === "function") {
            array.forEach(callback);
        } else if (typeof array.next === "function") {
            i = 0;
            do {
                var result = array.next();
                callback(result.value, i++, array);
            } while (!result.done);
        } else if (isFunction(array)) {
            // Also allow the first argument to be a custom iterator function
            array(callback);
            // eslint-disable-next-line no-constant-condition
        }
    },

    /**
     * Helper to render a dynamic tag
     */
    d: function dynamicTag(out, tag, attrs, args, props, componentDef, key, customEvents) {
        if (tag) {
            var component = componentDef && componentDef._b_;
            if (typeof tag === "string") {
                if (customEvents) {
                    if (!props) {
                        props = {};
                    }

                    customEvents.forEach(function (eventArray) {
                        props["on" + eventArray[0]] = componentDef.d(eventArray[0], eventArray[1], eventArray[2], eventArray[3]);
                    });
                }

                if (attrs.renderBody) {
                    var renderBody = attrs.renderBody;
                    var otherAttrs = {};
                    for (var attrKey in attrs) {
                        if (attrKey !== "renderBody") {
                            otherAttrs[attrKey] = attrs[attrKey];
                        }
                    }
                    out.aN_(tag, otherAttrs, key, component, 0, 0, props);
                    renderBody(out);
                    out.aO_();
                } else {
                    out.aP_(tag, attrs, key, component, 0, 0, props);
                }
            } else {
                if (attrs == null) {
                    attrs = {};
                } else if (typeof attrs === "object") {
                    attrs = Object.keys(attrs).reduce(function (r, key) {
                        r[removeDashes(key)] = attrs[key];
                        return r;
                    }, {});
                }

                if (tag._ || tag.renderer || tag.render) {
                    var renderer = tag._ || tag.renderer || tag.render;
                    out.c(componentDef, key, customEvents);
                    renderer(attrs, out);
                    out.ai_ = null;
                } else {
                    var render = tag && tag.renderBody || tag;
                    var isFn = typeof render === "function";

                    if (render.safeHTML) {

                        out.write(tag.safeHTML);
                        // eslint-disable-next-line no-constant-condition

                        return;
                    }

                    if (isFn) {
                        var flags = componentDef ? componentDef._f_ : 0;
                        var willRerender = flags & FLAG_WILL_RERENDER_IN_BROWSER;
                        var isW10NOOP = render === w10NOOP;
                        var preserve = IS_SERVER ? willRerender : isW10NOOP;
                        out.aQ_(key, component, preserve);
                        if (!isW10NOOP && isFn) {
                            var componentsContext = getComponentsContext(out);
                            var parentComponentDef = componentsContext._p_;
                            var globalContext = componentsContext.O_;
                            componentsContext._p_ = new ComponentDef(component, parentComponentDef.id + "-" + parentComponentDef._i_(key), globalContext);
                            render.toJSON = RENDER_BODY_TO_JSON;

                            if (args) {
                                render.apply(null, [out].concat(args, attrs));
                            } else {
                                render(out, attrs);
                            }

                            componentsContext._p_ = parentComponentDef;
                        }
                        out.aR_();
                    } else {
                        out.error("Invalid dynamic tag value");
                    }
                }
            }
        }
    },

    /**
     * Helper to load a custom tag
     */
    t: function loadTagHelper(renderer) {
        if (renderer) {
            renderer = resolveRenderer(renderer);
        }

        return function wrappedRenderer(input, out, componentDef, key, customEvents) {
            out.c(componentDef, key, customEvents);
            renderer(input, out);
            out.ai_ = null;
        };
    },

    /**
     * classList(a, b, c, ...)
     * Joines a list of class names with spaces. Empty class names are omitted.
     *
     * classList('a', undefined, 'b') --> 'a b'
     *
     */
    cl: function classListHelper() {
        var classNames = [];
        classList(arguments, classNames);
        return classNames.join(" ");
    }
};

module.exports = helpers;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/helpers", function(require, exports, module, __filename, __dirname) { "use strict";

var vdom = require('/marko$4.16.3/dist/runtime/vdom/vdom'/*"./vdom"*/);
var VElement = vdom.ay_;
var VText = vdom.aY_;

var commonHelpers = require('/marko$4.16.3/dist/runtime/helpers'/*"../helpers"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

var classList = commonHelpers.cl;

var helpers = extend({
    e: function (tagName, attrs, key, component, childCount, flags, props) {
        return new VElement(tagName, attrs, key, component, childCount, flags, props);
    },

    t: function (value) {
        return new VText(value);
    },

    const: function (id) {
        var i = 0;
        return function () {
            return id + i++;
        };
    },

    /**
     * Internal helper method to handle the "class" attribute. The value can either
     * be a string, an array or an object. For example:
     *
     * ca('foo bar') ==> ' class="foo bar"'
     * ca({foo: true, bar: false, baz: true}) ==> ' class="foo baz"'
     * ca(['foo', 'bar']) ==> ' class="foo bar"'
     */
    ca: function (classNames) {
        if (!classNames) {
            return null;
        }

        if (typeof classNames === "string") {
            return classNames;
        } else {
            return classList(classNames);
        }
    },

    as: require('/marko$4.16.3/dist/runtime/vdom/helper-attrs'/*"./helper-attrs"*/)
}, commonHelpers);

module.exports = helpers;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/helper-attrs", function(require, exports, module, __filename, __dirname) { /**
 * Helper for processing dynamic attributes
 */
module.exports = function (attributes) {
    if (attributes && (attributes.style || attributes.class)) {
        var newAttributes = {};
        Object.keys(attributes).forEach(function (name) {
            if (name === "class") {
                newAttributes[name] = classAttr(attributes[name]);
            } else if (name === "style") {
                newAttributes[name] = styleAttr(attributes[name]);
            } else {
                newAttributes[name] = attributes[name];
            }
        });
        return newAttributes;
    }
    return attributes;
};

var styleAttr = require('/marko$4.16.3/dist/runtime/vdom/helper-styleAttr'/*"./helper-styleAttr"*/);
var classAttr = require('/marko$4.16.3/dist/runtime/vdom/helpers'/*"./helpers"*/).ca;
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/AsyncVDOMBuilder", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var vdom = require('/marko$4.16.3/dist/runtime/vdom/vdom'/*"./vdom"*/);
var VElement = vdom.ay_;
var VDocumentFragment = vdom.aW_;
var VComment = vdom.aX_;
var VText = vdom.aY_;
var VComponent = vdom.aZ_;
var VFragment = vdom.b__;
var virtualizeHTML = vdom.ba_;
var RenderResult = require('/marko$4.16.3/dist/runtime/RenderResult'/*"../RenderResult"*/);
var defaultDocument = vdom.bb_;
var morphdom = require('/marko$4.16.3/dist/morphdom/index'/*"../../morphdom"*/);
var attrsHelper = require('/marko$4.16.3/dist/runtime/vdom/helper-attrs'/*"./helper-attrs"*/);

var EVENT_UPDATE = "update";
var EVENT_FINISH = "finish";

function State(tree) {
    this.bc_ = new EventEmitter();
    this.bd_ = tree;
    this.be_ = false;
}

function AsyncVDOMBuilder(globalData, parentNode, parentOut) {
    if (!parentNode) {
        parentNode = new VDocumentFragment();
    }

    var state;

    if (parentOut) {
        state = parentOut.g_;
    } else {
        state = new State(parentNode);
    }

    this.bf_ = 1;
    this.bg_ = 0;
    this.bh_ = null;
    this.bi_ = parentOut;

    this.data = {};
    this.g_ = state;
    this.al_ = parentNode;
    this.global = globalData || {};
    this.bj_ = [parentNode];
    this.bk_ = false;
    this.bl_ = undefined;
    this._r_ = null;

    this.ai_ = null;
    this._Z_ = null;
    this.aj_ = null;
}

var proto = AsyncVDOMBuilder.prototype = {
    aS_: true,
    u_: defaultDocument,

    bc: function (component, key, ownerComponent) {
        var vComponent = new VComponent(component, key, ownerComponent);
        return this.bm_(vComponent, 0, true);
    },

    an_: function (component, key, ownerComponent) {
        var vComponent = new VComponent(component, key, ownerComponent, true);
        this.bm_(vComponent, 0);
    },

    bm_: function (child, childCount, pushToStack) {
        this.al_.bn_(child);
        if (pushToStack === true) {
            this.bj_.push(child);
            this.al_ = child;
        }
        return childCount === 0 ? this : child;
    },

    element: function (tagName, attrs, key, component, childCount, flags, props) {
        var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
        return this.bm_(element, childCount);
    },

    aP_: function (tagName, attrs, key, component, childCount, flags, props) {
        var element = VElement.bo_(tagName, attrsHelper(attrs), key, component, childCount, flags, props);
        return this.bm_(element, childCount);
    },

    n: function (node, component) {
        // NOTE: We do a shallow clone since we assume the node is being reused
        //       and a node can only have one parent node.
        var clone = node.bp_();
        this.node(clone);
        clone.aF_ = component;

        return this;
    },

    node: function (node) {
        this.al_.bn_(node);
        return this;
    },

    text: function (text) {
        var type = typeof text;

        if (type != "string") {
            if (text == null) {
                return;
            } else if (type === "object") {
                if (text.toHTML) {
                    return this.h(text.toHTML());
                }
            }

            text = text.toString();
        }

        this.al_.bn_(new VText(text));
        return this;
    },

    comment: function (comment) {
        return this.node(new VComment(comment));
    },

    html: function (html) {
        if (html != null) {
            var vdomNode = virtualizeHTML(html, this.u_ || document);
            this.node(vdomNode);
        }

        return this;
    },

    beginElement: function (tagName, attrs, key, component, childCount, flags, props) {
        var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
        this.bm_(element, childCount, true);
        return this;
    },

    aN_: function (tagName, attrs, key, component, childCount, flags, props) {
        var element = VElement.bo_(tagName, attrsHelper(attrs), key, component, childCount, flags, props);
        this.bm_(element, childCount, true);
        return this;
    },

    aQ_: function (key, component, preserve) {
        var fragment = new VFragment(key, component, preserve);
        this.bm_(fragment, null, true);
        return this;
    },

    aR_: function () {
        this.endElement();
    },

    endElement: function () {
        var stack = this.bj_;
        stack.pop();
        this.al_ = stack[stack.length - 1];
    },

    end: function () {
        this.al_ = undefined;

        var remaining = --this.bf_;
        var parentOut = this.bi_;

        if (remaining === 0) {
            if (parentOut) {
                parentOut.bq_();
            } else {
                this.br_();
            }
        } else if (remaining - this.bg_ === 0) {
            this.bs_();
        }

        return this;
    },

    bq_: function () {
        var remaining = --this.bf_;

        if (remaining === 0) {
            var parentOut = this.bi_;
            if (parentOut) {
                parentOut.bq_();
            } else {
                this.br_();
            }
        } else if (remaining - this.bg_ === 0) {
            this.bs_();
        }
    },

    br_: function () {
        var state = this.g_;
        state.be_ = true;
        state.bc_.emit(EVENT_FINISH, this.aT_());
    },

    bs_: function () {
        var lastArray = this._last;

        var i = 0;

        function next() {
            if (i === lastArray.length) {
                return;
            }
            var lastCallback = lastArray[i++];
            lastCallback(next);

            if (!lastCallback.length) {
                next();
            }
        }

        next();
    },

    error: function (e) {
        try {
            this.emit("error", e);
        } finally {
            // If there is no listener for the error event then it will
            // throw a new Error here. In order to ensure that the async fragment
            // is still properly ended we need to put the end() in a `finally`
            // block
            this.end();
        }

        return this;
    },

    beginAsync: function (options) {
        if (this.bk_) {
            throw Error("Tried to render async while in sync mode. Note: Client side await is not currently supported in re-renders (Issue: #942).");
        }

        var state = this.g_;

        if (options) {
            if (options.last) {
                this.bg_++;
            }
        }

        this.bf_++;

        var documentFragment = this.al_.bt_();
        var asyncOut = new AsyncVDOMBuilder(this.global, documentFragment, this);

        state.bc_.emit("beginAsync", {
            out: asyncOut,
            parentOut: this
        });

        return asyncOut;
    },

    createOut: function () {
        return new AsyncVDOMBuilder(this.global);
    },

    flush: function () {
        var events = this.g_.bc_;

        if (events.listenerCount(EVENT_UPDATE)) {
            events.emit(EVENT_UPDATE, new RenderResult(this));
        }
    },

    R_: function () {
        return this.g_.bd_;
    },

    aT_: function () {
        return this.bu_ || (this.bu_ = new RenderResult(this));
    },

    on: function (event, callback) {
        var state = this.g_;

        if (event === EVENT_FINISH && state.be_) {
            callback(this.aT_());
        } else if (event === "last") {
            this.onLast(callback);
        } else {
            state.bc_.on(event, callback);
        }

        return this;
    },

    once: function (event, callback) {
        var state = this.g_;

        if (event === EVENT_FINISH && state.be_) {
            callback(this.aT_());
        } else if (event === "last") {
            this.onLast(callback);
        } else {
            state.bc_.once(event, callback);
        }

        return this;
    },

    emit: function (type, arg) {
        var events = this.g_.bc_;
        switch (arguments.length) {
            case 1:
                events.emit(type);
                break;
            case 2:
                events.emit(type, arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }
        return this;
    },

    removeListener: function () {
        var events = this.g_.bc_;
        events.removeListener.apply(events, arguments);
        return this;
    },

    sync: function () {
        this.bk_ = true;
    },

    isSync: function () {
        return this.bk_;
    },

    onLast: function (callback) {
        var lastArray = this._last;

        if (lastArray === undefined) {
            this._last = [callback];
        } else {
            lastArray.push(callback);
        }

        return this;
    },

    aL_: function (doc) {
        var node = this.bl_;
        if (!node) {
            var vdomTree = this.R_();
            // Create the root document fragment node
            doc = doc || this.u_ || document;
            this.bl_ = node = vdomTree.aC_(doc);
            morphdom(node, vdomTree, doc, this._r_);
        }
        return node;
    },

    toString: function (doc) {
        var docFragment = this.aL_(doc);
        var html = "";

        var child = docFragment.firstChild;
        while (child) {
            var nextSibling = child.nextSibling;
            if (child.nodeType != 1) {
                var container = docFragment.ownerDocument.createElement("div");
                container.appendChild(child.cloneNode());
                html += container.innerHTML;
            } else {
                html += child.outerHTML;
            }

            child = nextSibling;
        }

        return html;
    },

    then: function (fn, fnErr) {
        var out = this;
        var promise = new Promise(function (resolve, reject) {
            out.on("error", reject).on(EVENT_FINISH, function (result) {
                resolve(result);
            });
        });

        return Promise.resolve(promise).then(fn, fnErr);
    },

    catch: function (fnErr) {
        return this.then(undefined, fnErr);
    },

    isVDOM: true,

    c: function (componentDef, key, customEvents) {
        this.ai_ = componentDef;
        this._Z_ = key;
        this.aj_ = customEvents;
    }
};

proto.e = proto.element;
proto.be = proto.beginElement;
proto.ee = proto.aO_ = proto.endElement;
proto.t = proto.text;
proto.h = proto.w = proto.write = proto.html;

module.exports = AsyncVDOMBuilder;
});
$_mod.def("/marko$4.16.3/dist/runtime/renderable", function(require, exports, module, __filename, __dirname) { var defaultCreateOut = require('/marko$4.16.3/dist/runtime/createOut'/*"./createOut"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function safeRender(renderFunc, finalData, finalOut, shouldEnd) {
    try {
        renderFunc(finalData, finalOut);

        if (shouldEnd) {
            finalOut.end();
        }
    } catch (err) {
        var actualEnd = finalOut.end;
        finalOut.end = function () {};

        setTimeout(function () {
            finalOut.end = actualEnd;
            finalOut.error(err);
        }, 0);
    }
    return finalOut;
}

module.exports = function (target, renderer) {
    var renderFunc = renderer && (renderer.renderer || renderer.render || renderer);
    var createOut = target.createOut || renderer.createOut || defaultCreateOut;

    return extend(target, {
        createOut: createOut,

        renderToString: function (data, callback) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            if (callback) {
                out.on("finish", function () {
                    callback(null, out.toString(), out);
                }).once("error", callback);

                return safeRender(render, localData, out, true);
            } else {
                out.sync();
                render(localData, out);
                return out.toString();
            }
        },

        renderSync: function (data) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);
            out.sync();

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            render(localData, out);
            return out.aT_();
        },

        /**
         * Renders a template to either a stream (if the last
         * argument is a Stream instance) or
         * provides the output to a callback function (if the last
         * argument is a Function).
         *
         * Supported signatures:
         *
         * render(data)
         * render(data, out)
         * render(data, stream)
         * render(data, callback)
         *
         * @param  {Object} data The view model data for the template
         * @param  {AsyncStream/AsyncVDOMBuilder} out A Stream, an AsyncStream/AsyncVDOMBuilder instance, or a callback function
         * @return {AsyncStream/AsyncVDOMBuilder} Returns the AsyncStream/AsyncVDOMBuilder instance that the template is rendered to
         */
        render: function (data, out) {
            var callback;
            var finalOut;
            var finalData;
            var globalData;
            var render = renderFunc || this._;
            var shouldBuffer = this.aU_;
            var shouldEnd = true;

            if (data) {
                finalData = data;
                if (globalData = data.$global) {
                    finalData.$global = undefined;
                }
            } else {
                finalData = {};
            }

            if (out && out.aS_) {
                finalOut = out;
                shouldEnd = false;
                extend(out.global, globalData);
            } else if (typeof out == "function") {
                finalOut = createOut(globalData);
                callback = out;
            } else {
                finalOut = createOut(globalData, // global
                out, // writer(AsyncStream) or parentNode(AsyncVDOMBuilder)
                undefined, // parentOut
                shouldBuffer // ignored by AsyncVDOMBuilder
                );
            }

            if (callback) {
                finalOut.on("finish", function () {
                    callback(null, finalOut.aT_());
                }).once("error", callback);
            }

            globalData = finalOut.global;

            globalData.template = globalData.template || this;

            return safeRender(render, finalData, finalOut, shouldEnd);
        }
    });
};
});
$_mod.def("/marko$4.16.3/dist/runtime/vdom/index", function(require, exports, module, __filename, __dirname) { "use strict";

require('/marko$4.16.3/dist/index-browser'/*"../../"*/);

// helpers provide a core set of various utility methods
// that are available in every template
var AsyncVDOMBuilder = require('/marko$4.16.3/dist/runtime/vdom/AsyncVDOMBuilder'/*"./AsyncVDOMBuilder"*/);
var makeRenderable = require('/marko$4.16.3/dist/runtime/renderable'/*"../renderable"*/);

/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.t = function createTemplate(path) {
    return new Template(path);
};

function Template(path, func) {
    this.path = path;
    this._ = func;
    this.meta = undefined;
}

function createOut(globalData, parent, parentOut) {
    return new AsyncVDOMBuilder(globalData, parent, parentOut);
}

var Template_prototype = Template.prototype = {
    createOut: createOut
};

makeRenderable(Template_prototype);

exports.Template = Template;
exports.aV_ = createOut;

require('/marko$4.16.3/dist/runtime/createOut'/*"../createOut"*/).aM_(createOut);
});
$_mod.def("/marko$4.16.3/dist/vdom", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.16.3/dist/runtime/vdom/index'/*"./runtime/vdom"*/);
});
$_mod.remap("/marko$4.16.3/dist/components/helpers", "/marko$4.16.3/dist/components/helpers-browser");
$_mod.remap("/marko$4.16.3/dist/components/beginComponent", "/marko$4.16.3/dist/components/beginComponent-browser");
$_mod.def("/marko$4.16.3/dist/components/beginComponent-browser", function(require, exports, module, __filename, __dirname) { var ComponentDef = require('/marko$4.16.3/dist/components/ComponentDef'/*"./ComponentDef"*/);

module.exports = function beginComponent(componentsContext, component, key, ownerComponentDef) {
    var componentId = component.id;

    var globalContext = componentsContext.O_;
    var componentDef = componentsContext._p_ = new ComponentDef(component, componentId, globalContext);
    globalContext._z_[componentId] = true;
    componentsContext._r_.push(componentDef);

    var out = componentsContext._s_;
    out.bc(component, key, ownerComponentDef && ownerComponentDef._b_);
    return componentDef;
};
});
$_mod.remap("/marko$4.16.3/dist/components/endComponent", "/marko$4.16.3/dist/components/endComponent-browser");
$_mod.def("/marko$4.16.3/dist/components/endComponent-browser", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function endComponent(out) {
    out.ee(); // endElement() (also works for VComponent nodes pushed on to the stack)
};
});
$_mod.def("/marko$4.16.3/dist/components/renderer", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.16.3/dist/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.a_;
var emitLifecycleEvent = componentsUtil.b_;

var ComponentsContext = require('/marko$4.16.3/dist/components/ComponentsContext'/*"./ComponentsContext"*/);
var getComponentsContext = ComponentsContext.__;
var registry = require('/marko$4.16.3/dist/components/registry-browser'/*"./registry"*/);
var copyProps = require('/raptor-util$3.2.0/copyProps'/*"raptor-util/copyProps"*/);
var isServer = componentsUtil.ak_ === true;
var beginComponent = require('/marko$4.16.3/dist/components/beginComponent-browser'/*"./beginComponent"*/);
var endComponent = require('/marko$4.16.3/dist/components/endComponent-browser'/*"./endComponent"*/);

var COMPONENT_BEGIN_ASYNC_ADDED_KEY = "$wa";

function resolveComponentKey(key, parentComponentDef) {
    if (key[0] === "#") {
        return key.substring(1);
    } else {
        return parentComponentDef.id + "-" + parentComponentDef._i_(key);
    }
}

function handleBeginAsync(event) {
    var parentOut = event.parentOut;
    var asyncOut = event.out;
    var componentsContext = parentOut._r_;

    if (componentsContext !== undefined) {
        // We are going to start a nested ComponentsContext
        asyncOut._r_ = new ComponentsContext(asyncOut, componentsContext);
    }
    // Carry along the component arguments
    asyncOut.c(parentOut.ai_, parentOut._Z_, parentOut.aj_);
}

function createRendererFunc(templateRenderFunc, componentProps, renderingLogic) {
    renderingLogic = renderingLogic || {};
    var onInput = renderingLogic.onInput;
    var typeName = componentProps._l_;
    var isSplit = componentProps.ah_ === true;
    var isImplicitComponent = componentProps.am_ === true;

    var shouldApplySplitMixins = isSplit;

    return function renderer(input, out) {
        var outGlobal = out.global;

        if (out.isSync() === false) {
            if (!outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY]) {
                outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY] = true;
                out.on("beginAsync", handleBeginAsync);
            }
        }

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.O_;

        var component = globalComponentsContext.P_;
        var isRerender = component !== undefined;
        var id;
        var isExisting;
        var customEvents;
        var parentComponentDef = componentsContext._p_;
        var ownerComponentDef = out.ai_;
        var ownerComponentId = ownerComponentDef && ownerComponentDef.id;
        var key = out._Z_;

        if (component) {
            // If component is provided then we are currently rendering
            // the top-level UI component as part of a re-render
            id = component.id; // We will use the ID of the component being re-rendered
            isExisting = true; // This is a re-render so we know the component is already in the DOM
            globalComponentsContext.P_ = null;
        } else {
            // Otherwise, we are rendering a nested UI component. We will need
            // to match up the UI component with the component already in the
            // DOM (if any) so we will need to resolve the component ID from
            // the assigned key. We also need to handle any custom event bindings
            // that were provided.
            if (parentComponentDef) {
                // console.log('componentArgs:', componentArgs);
                customEvents = out.aj_;

                if (key != null) {
                    id = resolveComponentKey(key.toString(), parentComponentDef);
                } else {
                    id = parentComponentDef._k_();
                }
            } else {
                id = globalComponentsContext._k_();
            }
        }

        if (isServer) {
            // If we are rendering on the server then things are simplier since
            // we don't need to match up the UI component with a previously
            // rendered component already mounted to the DOM. We also create
            // a lightweight ServerComponent
            component = registry._n_(renderingLogic, id, input, out, typeName, customEvents, ownerComponentId);

            // This is the final input after running the lifecycle methods.
            // We will be passing the input to the template for the `input` param
            input = component._C_;

            component._C_ = undefined; // We don't want ___updatedInput to be serialized to the browser
        } else {
            if (!component) {
                if (isRerender && (component = componentLookup[id]) && component._l_ !== typeName) {
                    // Destroy the existing component since
                    component.destroy();
                    component = undefined;
                }

                if (component) {
                    isExisting = true;
                } else {
                    isExisting = false;
                    // We need to create a new instance of the component
                    component = registry._n_(typeName, id);

                    if (shouldApplySplitMixins === true) {
                        shouldApplySplitMixins = false;

                        var renderingLogicProps = typeof renderingLogic == "function" ? renderingLogic.prototype : renderingLogic;

                        copyProps(renderingLogicProps, component.constructor.prototype);
                    }
                }

                // Set this flag to prevent the component from being queued for update
                // based on the new input. The component is about to be rerendered
                // so we don't want to queue it up as a result of calling `setInput()`
                component.r_ = true;

                if (customEvents !== undefined) {
                    component.W_(customEvents, ownerComponentId);
                }

                if (isExisting === false) {
                    emitLifecycleEvent(component, "create", input, out);
                }

                input = component.F_(input, onInput, out);

                if (isExisting === true) {
                    if (component.I_ === false || component.shouldUpdate(input, component.g_) === false) {
                        // We put a placeholder element in the output stream to ensure that the existing
                        // DOM node is matched up correctly when using morphdom. We flag the VElement
                        // node to track that it is a preserve marker
                        out.an_(component);
                        globalComponentsContext._z_[id] = true;
                        component.f_(); // The component is no longer dirty so reset internal flags
                        return;
                    }
                }
            }

            component.p_ = outGlobal;

            emitLifecycleEvent(component, "render", out);
        }

        var componentDef = beginComponent(componentsContext, component, key, ownerComponentDef, isSplit, isImplicitComponent);

        componentDef._d_ = isExisting;

        // Render the template associated with the component using the final template
        // data that we constructed
        templateRenderFunc(input, out, componentDef, component, component.U_);

        endComponent(out, componentDef);
        componentsContext._p_ = parentComponentDef;
    };
}

module.exports = createRendererFunc;

// exports used by the legacy renderer
createRendererFunc._W_ = resolveComponentKey;
createRendererFunc.ag_ = handleBeginAsync;
});
$_mod.def("/marko$4.16.3/dist/components/helpers-browser", function(require, exports, module, __filename, __dirname) { require('/marko$4.16.3/dist/components/index-browser'/*"./"*/);

exports.c = require('/marko$4.16.3/dist/components/defineComponent'/*"./defineComponent"*/); // Referenced by compiled templates
exports.r = require('/marko$4.16.3/dist/components/renderer'/*"./renderer"*/); // Referenced by compiled templates
exports.rc = require('/marko$4.16.3/dist/components/registry-browser'/*"./registry"*/)._Q_; // Referenced by compiled templates
});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/routes", function(require, exports, module, __filename, __dirname) { var routes = [{
  name: 'about',
  path: '/about',
  pageName: 'about'
}, {
  name: 'home',
  path: '/home',
  pageName: 'home'
}];

exports.routes = routes;
});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/component", function(require, exports, module, __filename, __dirname) { var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var config = require('/app$1.0.0/src/routes/mobile/components/app/routes'/*'./routes'*/);
module.exports = function () {
  function _class() {
    _classCallCheck(this, _class);
  }

  _createClass(_class, [{
    key: 'onCreate',
    value: function onCreate() {}
  }, {
    key: 'onMount',
    value: function onMount() {
      this.start();
      this.addBackHandlers();
    }
  }, {
    key: 'addBackHandlers',
    value: function addBackHandlers() {
      Dom7("a.move-back").on('click', function () {
        window.app.views.main.router.back();
      });
    }
  }, {
    key: 'start',
    value: function start() {
      var theme = 'auto';
      if (document.location.search.indexOf('theme=') >= 0) {
        theme = document.location.search.split('theme=')[1].split('&')[0];
      }
      var app = new Framework7({
        theme: theme,
        root: '#app',

        name: 'My App',

        id: 'com.myapp.test',

        panel: {
          swipe: 'left'
        },

        routes: config.routes

      });
      var mainView = app.views.create('.view-main', {
        stackPages: true,
        pushState: true,
        url: "/mobile"

      });
      window.app = app;
      var thisComp = this;
      var informChild = function (pageName, eventHandler) {
        var page = thisComp.getComponent(pageName);
        page && typeof page[eventHandler] === 'function' && page[eventHandler]();
      };
      setTimeout(function () {

        var router = app.views.main.router;

        router.clearPreviousHistory();

        app.on('pageBeforeIn', function (page) {

          informChild(page.name, 'pageBeforeIn');
        });
        app.on('pageAfterIn', function (page) {
          informChild(page.name, 'pageAfterIn');
        });

        app.on('pageBeforeOut', function (page) {
          informChild(page.name, 'pageBeforeOut');
        });
        app.on('pageAfterOut', function (page) {
          informChild(page.name, 'pageAfterOut');
        });
      }, 1);
    }
  }]);

  return _class;
}();
});
$_mod.main("/app$1.0.0/src/routes/mobile/routes/home-page", "index.marko");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/home-page/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.16.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.16.3/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_helpers = require('/marko$4.16.3/dist/components/helpers-browser'/*"marko/dist/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/home-page/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require('/marko$4.16.3/dist/runtime/vdom/helpers'/*"marko/dist/runtime/vdom/helpers"*/),
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("8325d9"),
    marko_node0 = marko_createElement("DIV", {
        id: "home",
        "data-name": "home",
        "class": "page"
      }, "0", null, 3, 0, {
        i: marko_const_nextId()
      })
      .e("DIV", {
          "class": "navbar"
        }, null, null, 1)
        .e("DIV", {
            "class": "navbar-inner sliding"
          }, null, null, 1)
          .e("DIV", {
              "class": "title"
            }, null, null, 1)
            .t("Home ")
      .e("DIV", {
          "class": "toolbar"
        }, null, null, 1)
        .e("DIV", {
            "class": "toolbar-inner"
          }, null, null, 2)
          .e("A", {
              href: "#",
              "class": "link"
            }, null, null, 1)
            .t("Link 1")
          .e("A", {
              href: "#",
              "class": "link"
            }, null, null, 1)
            .t("Link 2")
      .e("DIV", {
          "class": "page-content"
        }, null, null, 2)
        .e("P", null, null, null, 1)
          .t("Page content goes here")
        .e("A", {
            href: "/about"
          }, null, null, 1)
          .t("About app");

function render(input, out, __component, component, state) {
  var data = input;

  out.n(marko_node0, component);
}

marko_template._ = marko_renderer(render, {
    am_: true,
    _l_: marko_componentType
  });

marko_template.Component = marko_defineComponent({}, marko_template._);

});
$_mod.main("/app$1.0.0/src/routes/mobile/routes/about-page", "index.marko");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/about-page/component", function(require, exports, module, __filename, __dirname) { function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

module.exports = function () {
    function _class() {
        _classCallCheck(this, _class);
    }

    return _class;
}();
});
$_mod.def("/app$1.0.0/src/routes/mobile/routes/about-page/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.16.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.16.3/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_helpers = require('/marko$4.16.3/dist/components/helpers-browser'/*"marko/dist/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/about-page/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/app$1.0.0/src/routes/mobile/routes/about-page/component'/*"./component"*/),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require('/marko$4.16.3/dist/runtime/vdom/helpers'/*"marko/dist/runtime/vdom/helpers"*/),
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("3100d6"),
    marko_node0 = marko_createElement("DIV", {
        id: "about",
        "data-name": "about",
        "class": "page stacked"
      }, "0", null, 4, 0, {
        i: marko_const_nextId()
      })
      .e("DIV", {
          "class": "navbar"
        }, null, null, 1)
        .e("DIV", {
            "class": "navbar-inner sliding"
          }, null, null, 2)
          .e("DIV", {
              "class": "left"
            }, null, null, 1)
            .e("A", {
                "class": "link move-back"
              }, null, null, 2)
              .e("I", {
                  "class": "icon icon-back"
                }, null, null, 0)
              .e("SPAN", null, null, null, 1)
                .t("Back")
          .e("DIV", {
              "class": "title"
            }, null, null, 1)
            .t("About")
      .e("DIV", {
          "class": "toolbar"
        }, null, null, 1)
        .e("DIV", {
            "class": "toolbar-inner"
          }, null, null, 2)
          .e("A", {
              href: "#",
              "class": "link"
            }, null, null, 1)
            .t("Link 3")
          .e("A", {
              href: "#",
              "class": "link"
            }, null, null, 1)
            .t("Link 4")
      .e("DIV", {
          "class": "page-content"
        }, null, null, 2)
        .e("P", null, null, null, 1)
          .t("Page content goes here")
        .e("A", {
            href: "/home"
          }, null, null, 1)
          .t("home app")
      .t(" ");

function render(input, out, __component, component, state) {
  var data = input;

  out.n(marko_node0, component);
}

marko_template._ = marko_renderer(render, {
    _l_: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.16.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.16.3/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_helpers = require('/marko$4.16.3/dist/components/helpers-browser'/*"marko/dist/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/components/app/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/app$1.0.0/src/routes/mobile/components/app/component'/*"./component"*/),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    home_page_template = require('/app$1.0.0/src/routes/mobile/routes/home-page/index.marko'/*"../../routes/home-page"*/),
    marko_helpers = require('/marko$4.16.3/dist/runtime/vdom/helpers'/*"marko/dist/runtime/vdom/helpers"*/),
    marko_loadTag = marko_helpers.t,
    home_page_tag = marko_loadTag(home_page_template),
    about_page_template = require('/app$1.0.0/src/routes/mobile/routes/about-page/index.marko'/*"../../routes/about-page"*/),
    about_page_tag = marko_loadTag(about_page_template),
    marko_attrs0 = {
        id: "app"
      },
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("dc93d2"),
    marko_node0 = marko_createElement("DIV", {
        "class": "statusbar"
      }, "1", null, 0, 0, {
        i: marko_const_nextId()
      }),
    marko_attrs1 = {
        "class": "view view-main"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.be("DIV", marko_attrs0, "0", component);

  out.n(marko_node0, component);

  out.be("DIV", marko_attrs1, "2", component);

  home_page_tag({}, out, __component, "home");

  about_page_tag({}, out, __component, "about");

  out.ee();

  out.ee();
}

marko_template._ = marko_renderer(render, {
    _l_: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.16.3/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/routes/mobile/components/app/index.marko", require('/app$1.0.0/src/routes/mobile/components/app/index.marko'/*"./index.marko"*/));
});
$_mod.run("/app$1.0.0/src/routes/mobile/components/app/index.marko.register");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/about-page/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.16.3/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/routes/mobile/routes/about-page/index.marko", require('/app$1.0.0/src/routes/mobile/routes/about-page/index.marko'/*"./index.marko"*/));
});
$_mod.run("/app$1.0.0/src/routes/mobile/routes/about-page/index.marko.register");
/**
 * Framework7 4.2.0
 * Full featured mobile HTML framework for building iOS & Android apps
 * http://framework7.io/
 *
 * Copyright 2014-2019 Vladimir Kharlampidi
 *
 * Released under the MIT License
 *
 * Released on: March 20, 2019
 */

!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?module.exports=t():"function"==typeof define&&define.amd?define(t):(e=e||self).Framework7=t()}(this,function(){"use strict";var t7ctx;t7ctx="undefined"!=typeof window?window:"undefined"!=typeof global?global:void 0;var Template7Context=t7ctx,Template7Utils={quoteSingleRexExp:new RegExp("'","g"),quoteDoubleRexExp:new RegExp('"',"g"),isFunction:function(e){return"function"==typeof e},escape:function(e){return void 0===e&&(e=""),e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")},helperToSlices:function(e){var t,a,r,n=Template7Utils.quoteDoubleRexExp,i=Template7Utils.quoteSingleRexExp,s=e.replace(/[{}#}]/g,"").trim().split(" "),o=[];for(a=0;a<s.length;a+=1){var l=s[a],p=void 0,c=void 0;if(0===a)o.push(l);else if(0===l.indexOf('"')||0===l.indexOf("'"))if(p=0===l.indexOf('"')?n:i,c=0===l.indexOf('"')?'"':"'",2===l.match(p).length)o.push(l);else{for(t=0,r=a+1;r<s.length;r+=1)if(l+=" "+s[r],s[r].indexOf(c)>=0){t=r,o.push(l);break}t&&(a=t)}else if(l.indexOf("=")>0){var d=l.split("="),u=d[0],h=d[1];if(p||(p=0===h.indexOf('"')?n:i,c=0===h.indexOf('"')?'"':"'"),2!==h.match(p).length){for(t=0,r=a+1;r<s.length;r+=1)if(h+=" "+s[r],s[r].indexOf(c)>=0){t=r;break}t&&(a=t)}var f=[u,h.replace(p,"")];o.push(f)}else o.push(l)}return o},stringToBlocks:function(e){var t,a,r=[];if(!e)return[];var n=e.split(/({{[^{^}]*}})/);for(t=0;t<n.length;t+=1){var i=n[t];if(""!==i)if(i.indexOf("{{")<0)r.push({type:"plain",content:i});else{if(i.indexOf("{/")>=0)continue;if((i=i.replace(/{{([#\/])*([ ])*/,"{{$1").replace(/([ ])*}}/,"}}")).indexOf("{#")<0&&i.indexOf(" ")<0&&i.indexOf("else")<0){r.push({type:"variable",contextName:i.replace(/[{}]/g,"")});continue}var s=Template7Utils.helperToSlices(i),o=s[0],l=">"===o,p=[],c={};for(a=1;a<s.length;a+=1){var d=s[a];Array.isArray(d)?c[d[0]]="false"!==d[1]&&d[1]:p.push(d)}if(i.indexOf("{#")>=0){var u="",h="",f=0,v=void 0,m=!1,g=!1,b=0;for(a=t+1;a<n.length;a+=1)if(n[a].indexOf("{{#")>=0&&(b+=1),n[a].indexOf("{{/")>=0&&(b-=1),n[a].indexOf("{{#"+o)>=0)u+=n[a],g&&(h+=n[a]),f+=1;else if(n[a].indexOf("{{/"+o)>=0){if(!(f>0)){v=a,m=!0;break}f-=1,u+=n[a],g&&(h+=n[a])}else n[a].indexOf("else")>=0&&0===b?g=!0:(g||(u+=n[a]),g&&(h+=n[a]));m&&(v&&(t=v),"raw"===o?r.push({type:"plain",content:u}):r.push({type:"helper",helperName:o,contextName:p,content:u,inverseContent:h,hash:c}))}else i.indexOf(" ")>0&&(l&&(o="_partial",p[0]&&(0===p[0].indexOf("[")?p[0]=p[0].replace(/[[\]]/g,""):p[0]='"'+p[0].replace(/"|'/g,"")+'"')),r.push({type:"helper",helperName:o,contextName:p,hash:c}))}}return r},parseJsVariable:function(e,t,a){return e.split(/([+ \-*\/^()&=|<>!%:?])/g).reduce(function(e,r){if(!r)return e;if(r.indexOf(t)<0)return e.push(r),e;if(!a)return e.push(JSON.stringify("")),e;var n=a;return r.indexOf(t+".")>=0&&r.split(t+".")[1].split(".").forEach(function(e){n=e in n?n[e]:void 0}),"string"==typeof n&&(n=JSON.stringify(n)),void 0===n&&(n="undefined"),e.push(n),e},[]).join("")},parseJsParents:function(e,t){return e.split(/([+ \-*^()&=|<>!%:?])/g).reduce(function(e,a){if(!a)return e;if(a.indexOf("../")<0)return e.push(a),e;if(!t||0===t.length)return e.push(JSON.stringify("")),e;var r=a.split("../").length-1,n=r>t.length?t[t.length-1]:t[r-1];return a.replace(/..\//g,"").split(".").forEach(function(e){n=void 0!==n[e]?n[e]:"undefined"}),!1===n||!0===n?(e.push(JSON.stringify(n)),e):null===n||"undefined"===n?(e.push(JSON.stringify("")),e):(e.push(JSON.stringify(n)),e)},[]).join("")},getCompileVar:function(e,t,a){void 0===a&&(a="data_1");var r,n,i=t,s=0;0===e.indexOf("../")?(s=e.split("../").length-1,n=i.split("_")[1]-s,i="ctx_"+(n>=1?n:1),r=e.split("../")[s].split(".")):0===e.indexOf("@global")?(i="Template7.global",r=e.split("@global.")[1].split(".")):0===e.indexOf("@root")?(i="root",r=e.split("@root.")[1].split(".")):r=e.split(".");for(var o=0;o<r.length;o+=1){var l=r[o];if(0===l.indexOf("@")){var p=a.split("_")[1];s>0&&(p=n),o>0?i+="[(data_"+p+" && data_"+p+"."+l.replace("@","")+")]":i="(data_"+p+" && data_"+p+"."+l.replace("@","")+")"}else(Number.isFinite?Number.isFinite(l):Template7Context.isFinite(l))?i+="["+l+"]":"this"===l||l.indexOf("this.")>=0||l.indexOf("this[")>=0||l.indexOf("this(")>=0?i=l.replace("this",t):i+="."+l}return i},getCompiledArguments:function(e,t,a){for(var r=[],n=0;n<e.length;n+=1)/^['"]/.test(e[n])?r.push(e[n]):/^(true|false|\d+)$/.test(e[n])?r.push(e[n]):r.push(Template7Utils.getCompileVar(e[n],t,a));return r.join(", ")}},Template7Helpers={_partial:function(e,t){var a=this,r=Template7Class.partials[e];return!r||r&&!r.template?"":(r.compiled||(r.compiled=new Template7Class(r.template).compile()),Object.keys(t.hash).forEach(function(e){a[e]=t.hash[e]}),r.compiled(a,t.data,t.root))},escape:function(e){if("string"!=typeof e)throw new Error('Template7: Passed context to "escape" helper should be a string');return Template7Utils.escape(e)},if:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a?t.fn(this,t.data):t.inverse(this,t.data)},unless:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a?t.inverse(this,t.data):t.fn(this,t.data)},each:function(e,t){var a=e,r="",n=0;if(Template7Utils.isFunction(a)&&(a=a.call(this)),Array.isArray(a)){for(t.hash.reverse&&(a=a.reverse()),n=0;n<a.length;n+=1)r+=t.fn(a[n],{first:0===n,last:n===a.length-1,index:n});t.hash.reverse&&(a=a.reverse())}else for(var i in a)n+=1,r+=t.fn(a[i],{key:i});return n>0?r:t.inverse(this)},with:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=e.call(this)),t.fn(a)},join:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a.join(t.hash.delimiter||t.hash.delimeter)},js:function js(expression,options){var data=options.data,func,execute=expression;return"index first last key".split(" ").forEach(function(e){if(void 0!==data[e]){var t=new RegExp("this.@"+e,"g"),a=new RegExp("@"+e,"g");execute=execute.replace(t,JSON.stringify(data[e])).replace(a,JSON.stringify(data[e]))}}),options.root&&execute.indexOf("@root")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@root",options.root)),execute.indexOf("@global")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@global",Template7Context.Template7.global)),execute.indexOf("../")>=0&&(execute=Template7Utils.parseJsParents(execute,options.parents)),func=execute.indexOf("return")>=0?"(function(){"+execute+"})":"(function(){return ("+execute+")})",eval(func).call(this)},js_if:function js_if(expression,options){var data=options.data,func,execute=expression;"index first last key".split(" ").forEach(function(e){if(void 0!==data[e]){var t=new RegExp("this.@"+e,"g"),a=new RegExp("@"+e,"g");execute=execute.replace(t,JSON.stringify(data[e])).replace(a,JSON.stringify(data[e]))}}),options.root&&execute.indexOf("@root")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@root",options.root)),execute.indexOf("@global")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@global",Template7Context.Template7.global)),execute.indexOf("../")>=0&&(execute=Template7Utils.parseJsParents(execute,options.parents)),func=execute.indexOf("return")>=0?"(function(){"+execute+"})":"(function(){return ("+execute+")})";var condition=eval(func).call(this);return condition?options.fn(this,options.data):options.inverse(this,options.data)}};Template7Helpers.js_compare=Template7Helpers.js_if;var Template7Options={},Template7Partials={},Template7Class=function(e){this.template=e},staticAccessors={options:{configurable:!0},partials:{configurable:!0},helpers:{configurable:!0}};function Template7(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a=e[0],r=e[1];if(2===e.length){var n=new Template7Class(a),i=n.compile()(r);return n=null,i}return new Template7Class(a)}Template7Class.prototype.compile=function compile(template,depth){void 0===template&&(template=this.template),void 0===depth&&(depth=1);var t=this;if(t.compiled)return t.compiled;if("string"!=typeof template)throw new Error("Template7: Template must be a string");var stringToBlocks=Template7Utils.stringToBlocks,getCompileVar=Template7Utils.getCompileVar,getCompiledArguments=Template7Utils.getCompiledArguments,blocks=stringToBlocks(template),ctx="ctx_"+depth,data="data_"+depth;if(0===blocks.length)return function(){return""};function getCompileFn(e,a){return e.content?t.compile(e.content,a):function(){return""}}function getCompileInverse(e,a){return e.inverseContent?t.compile(e.inverseContent,a):function(){return""}}var resultString="",i;for(resultString+=1===depth?"(function ("+ctx+", "+data+", root) {\n":"(function ("+ctx+", "+data+") {\n",1===depth&&(resultString+="function isArray(arr){return Array.isArray(arr);}\n",resultString+="function isFunction(func){return (typeof func === 'function');}\n",resultString+='function c(val, ctx) {if (typeof val !== "undefined" && val !== null) {if (isFunction(val)) {return val.call(ctx);} else return val;} else return "";}\n',resultString+="root = root || ctx_1 || {};\n"),resultString+="var r = '';\n",i=0;i<blocks.length;i+=1){var block=blocks[i];if("plain"!==block.type){var variable=void 0,compiledArguments=void 0;if("variable"===block.type&&(variable=getCompileVar(block.contextName,ctx,data),resultString+="r += c("+variable+", "+ctx+");"),"helper"===block.type){var parents=void 0;if("ctx_1"!==ctx){for(var level=ctx.split("_")[1],parentsString="ctx_"+(level-1),j=level-2;j>=1;j-=1)parentsString+=", ctx_"+j;parents="["+parentsString+"]"}else parents="["+ctx+"]";var dynamicHelper=void 0;if(0===block.helperName.indexOf("[")&&(block.helperName=getCompileVar(block.helperName.replace(/[[\]]/g,""),ctx,data),dynamicHelper=!0),dynamicHelper||block.helperName in Template7Helpers)compiledArguments=getCompiledArguments(block.contextName,ctx,data),resultString+="r += (Template7Helpers"+(dynamicHelper?"["+block.helperName+"]":"."+block.helperName)+").call("+ctx+", "+(compiledArguments&&compiledArguments+", ")+"{hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});";else{if(block.contextName.length>0)throw new Error('Template7: Missing helper: "'+block.helperName+'"');variable=getCompileVar(block.helperName,ctx,data),resultString+="if ("+variable+") {",resultString+="if (isArray("+variable+")) {",resultString+="r += (Template7Helpers.each).call("+ctx+", "+variable+", {hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});",resultString+="}else {",resultString+="r += (Template7Helpers.with).call("+ctx+", "+variable+", {hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});",resultString+="}}"}}}else resultString+="r +='"+block.content.replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/'/g,"\\'")+"';"}return resultString+="\nreturn r;})",1===depth?(t.compiled=eval(resultString),t.compiled):resultString},staticAccessors.options.get=function(){return Template7Options},staticAccessors.partials.get=function(){return Template7Partials},staticAccessors.helpers.get=function(){return Template7Helpers},Object.defineProperties(Template7Class,staticAccessors),Template7.registerHelper=function(e,t){Template7Class.helpers[e]=t},Template7.unregisterHelper=function(e){Template7Class.helpers[e]=void 0,delete Template7Class.helpers[e]},Template7.registerPartial=function(e,t){Template7Class.partials[e]={template:t}},Template7.unregisterPartial=function(e){Template7Class.partials[e]&&(Template7Class.partials[e]=void 0,delete Template7Class.partials[e])},Template7.compile=function(e,t){return new Template7Class(e,t).compile()},Template7.options=Template7Class.options,Template7.helpers=Template7Class.helpers,Template7.partials=Template7Class.partials;var doc="undefined"==typeof document?{body:{},addEventListener:function(){},removeEventListener:function(){},activeElement:{blur:function(){},nodeName:""},querySelector:function(){return null},querySelectorAll:function(){return[]},getElementById:function(){return null},createEvent:function(){return{initEvent:function(){}}},createElement:function(){return{children:[],childNodes:[],style:{},setAttribute:function(){},getElementsByTagName:function(){return[]}}},location:{hash:""}}:document,win="undefined"==typeof window?{document:doc,navigator:{userAgent:""},location:{},history:{},CustomEvent:function(){return this},addEventListener:function(){},removeEventListener:function(){},getComputedStyle:function(){return{getPropertyValue:function(){return""}}},Image:function(){},Date:function(){},screen:{},setTimeout:function(){},clearTimeout:function(){}}:window,Dom7=function(e){for(var t=0;t<e.length;t+=1)this[t]=e[t];return this.length=e.length,this};function $(e,t){var a=[],r=0;if(e&&!t&&e instanceof Dom7)return e;if(e)if("string"==typeof e){var n,i,s=e.trim();if(s.indexOf("<")>=0&&s.indexOf(">")>=0){var o="div";for(0===s.indexOf("<li")&&(o="ul"),0===s.indexOf("<tr")&&(o="tbody"),0!==s.indexOf("<td")&&0!==s.indexOf("<th")||(o="tr"),0===s.indexOf("<tbody")&&(o="table"),0===s.indexOf("<option")&&(o="select"),(i=doc.createElement(o)).innerHTML=s,r=0;r<i.childNodes.length;r+=1)a.push(i.childNodes[r])}else for(n=t||"#"!==e[0]||e.match(/[ .<>:~]/)?(t||doc).querySelectorAll(e.trim()):[doc.getElementById(e.trim().split("#")[1])],r=0;r<n.length;r+=1)n[r]&&a.push(n[r])}else if(e.nodeType||e===win||e===doc)a.push(e);else if(e.length>0&&e[0].nodeType)for(r=0;r<e.length;r+=1)a.push(e[r]);return new Dom7(a)}function unique(e){for(var t=[],a=0;a<e.length;a+=1)-1===t.indexOf(e[a])&&t.push(e[a]);return t}function toCamelCase(e){return e.toLowerCase().replace(/-(.)/g,function(e,t){return t.toUpperCase()})}function requestAnimationFrame(e){return win.requestAnimationFrame?win.requestAnimationFrame(e):win.webkitRequestAnimationFrame?win.webkitRequestAnimationFrame(e):win.setTimeout(e,1e3/60)}function cancelAnimationFrame(e){return win.cancelAnimationFrame?win.cancelAnimationFrame(e):win.webkitCancelAnimationFrame?win.webkitCancelAnimationFrame(e):win.clearTimeout(e)}function addClass(e){if(void 0===e)return this;for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.add(t[a]);return this}function removeClass(e){for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.remove(t[a]);return this}function hasClass(e){return!!this[0]&&this[0].classList.contains(e)}function toggleClass(e){for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.toggle(t[a]);return this}function attr(e,t){var a=arguments;if(1===arguments.length&&"string"==typeof e)return this[0]?this[0].getAttribute(e):void 0;for(var r=0;r<this.length;r+=1)if(2===a.length)this[r].setAttribute(e,t);else for(var n in e)this[r][n]=e[n],this[r].setAttribute(n,e[n]);return this}function removeAttr(e){for(var t=0;t<this.length;t+=1)this[t].removeAttribute(e);return this}function prop(e,t){var a=arguments;if(1!==arguments.length||"string"!=typeof e){for(var r=0;r<this.length;r+=1)if(2===a.length)this[r][e]=t;else for(var n in e)this[r][n]=e[n];return this}if(this[0])return this[0][e]}function data(e,t){var a;if(void 0!==t){for(var r=0;r<this.length;r+=1)(a=this[r]).dom7ElementDataStorage||(a.dom7ElementDataStorage={}),a.dom7ElementDataStorage[e]=t;return this}if(a=this[0]){if(a.dom7ElementDataStorage&&e in a.dom7ElementDataStorage)return a.dom7ElementDataStorage[e];var n=a.getAttribute("data-"+e);return n||void 0}}function removeData(e){for(var t=0;t<this.length;t+=1){var a=this[t];a.dom7ElementDataStorage&&a.dom7ElementDataStorage[e]&&(a.dom7ElementDataStorage[e]=null,delete a.dom7ElementDataStorage[e])}}function dataset(){var e=this[0];if(e){var t={};if(e.dataset)for(var a in e.dataset)t[a]=e.dataset[a];else for(var r=0;r<e.attributes.length;r+=1){var n=e.attributes[r];n.name.indexOf("data-")>=0&&(t[toCamelCase(n.name.split("data-")[1])]=n.value)}for(var i in t)"false"===t[i]?t[i]=!1:"true"===t[i]?t[i]=!0:parseFloat(t[i])===1*t[i]&&(t[i]*=1);return t}}function val(e){if(void 0!==e){for(var t=0;t<this.length;t+=1){var a=this[t];if(Array.isArray(e)&&a.multiple&&"select"===a.nodeName.toLowerCase())for(var r=0;r<a.options.length;r+=1)a.options[r].selected=e.indexOf(a.options[r].value)>=0;else a.value=e}return this}if(this[0]){if(this[0].multiple&&"select"===this[0].nodeName.toLowerCase()){for(var n=[],i=0;i<this[0].selectedOptions.length;i+=1)n.push(this[0].selectedOptions[i].value);return n}return this[0].value}}function transform(e){for(var t=0;t<this.length;t+=1){var a=this[t].style;a.webkitTransform=e,a.transform=e}return this}function transition(e){"string"!=typeof e&&(e+="ms");for(var t=0;t<this.length;t+=1){var a=this[t].style;a.webkitTransitionDuration=e,a.transitionDuration=e}return this}function on(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2],s=t[3];function o(e){var t=e.target;if(t){var a=e.target.dom7EventData||[];if(a.indexOf(e)<0&&a.unshift(e),$(t).is(n))i.apply(t,a);else for(var r=$(t).parents(),s=0;s<r.length;s+=1)$(r[s]).is(n)&&i.apply(r[s],a)}}function l(e){var t=e&&e.target&&e.target.dom7EventData||[];t.indexOf(e)<0&&t.unshift(e),i.apply(this,t)}"function"==typeof t[1]&&(r=(e=t)[0],i=e[1],s=e[2],n=void 0),s||(s=!1);for(var p,c=r.split(" "),d=0;d<this.length;d+=1){var u=this[d];if(n)for(p=0;p<c.length;p+=1){var h=c[p];u.dom7LiveListeners||(u.dom7LiveListeners={}),u.dom7LiveListeners[h]||(u.dom7LiveListeners[h]=[]),u.dom7LiveListeners[h].push({listener:i,proxyListener:o}),u.addEventListener(h,o,s)}else for(p=0;p<c.length;p+=1){var f=c[p];u.dom7Listeners||(u.dom7Listeners={}),u.dom7Listeners[f]||(u.dom7Listeners[f]=[]),u.dom7Listeners[f].push({listener:i,proxyListener:l}),u.addEventListener(f,l,s)}}return this}function off(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2],s=t[3];"function"==typeof t[1]&&(r=(e=t)[0],i=e[1],s=e[2],n=void 0),s||(s=!1);for(var o=r.split(" "),l=0;l<o.length;l+=1)for(var p=o[l],c=0;c<this.length;c+=1){var d=this[c],u=void 0;if(!n&&d.dom7Listeners?u=d.dom7Listeners[p]:n&&d.dom7LiveListeners&&(u=d.dom7LiveListeners[p]),u&&u.length)for(var h=u.length-1;h>=0;h-=1){var f=u[h];i&&f.listener===i?(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1)):i&&f.listener&&f.listener.dom7proxy&&f.listener.dom7proxy===i?(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1)):i||(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1))}}return this}function once(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=this,n=t[0],i=t[1],s=t[2],o=t[3];function l(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];s.apply(this,e),r.off(n,i,l,o),l.dom7proxy&&delete l.dom7proxy}return"function"==typeof t[1]&&(n=(e=t)[0],s=e[1],o=e[2],i=void 0),l.dom7proxy=s,r.on(n,i,l,o)}function trigger(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];for(var a=e[0].split(" "),r=e[1],n=0;n<a.length;n+=1)for(var i=a[n],s=0;s<this.length;s+=1){var o=this[s],l=void 0;try{l=new win.CustomEvent(i,{detail:r,bubbles:!0,cancelable:!0})}catch(e){(l=doc.createEvent("Event")).initEvent(i,!0,!0),l.detail=r}o.dom7EventData=e.filter(function(e,t){return t>0}),o.dispatchEvent(l),o.dom7EventData=[],delete o.dom7EventData}return this}function transitionEnd(e){var t,a=["webkitTransitionEnd","transitionend"],r=this;function n(i){if(i.target===this)for(e.call(this,i),t=0;t<a.length;t+=1)r.off(a[t],n)}if(e)for(t=0;t<a.length;t+=1)r.on(a[t],n);return this}function animationEnd(e){var t,a=["webkitAnimationEnd","animationend"],r=this;function n(i){if(i.target===this)for(e.call(this,i),t=0;t<a.length;t+=1)r.off(a[t],n)}if(e)for(t=0;t<a.length;t+=1)r.on(a[t],n);return this}function width(){return this[0]===win?win.innerWidth:this.length>0?parseFloat(this.css("width")):null}function outerWidth(e){if(this.length>0){if(e){var t=this.styles();return this[0].offsetWidth+parseFloat(t.getPropertyValue("margin-right"))+parseFloat(t.getPropertyValue("margin-left"))}return this[0].offsetWidth}return null}function height(){return this[0]===win?win.innerHeight:this.length>0?parseFloat(this.css("height")):null}function outerHeight(e){if(this.length>0){if(e){var t=this.styles();return this[0].offsetHeight+parseFloat(t.getPropertyValue("margin-top"))+parseFloat(t.getPropertyValue("margin-bottom"))}return this[0].offsetHeight}return null}function offset(){if(this.length>0){var e=this[0],t=e.getBoundingClientRect(),a=doc.body,r=e.clientTop||a.clientTop||0,n=e.clientLeft||a.clientLeft||0,i=e===win?win.scrollY:e.scrollTop,s=e===win?win.scrollX:e.scrollLeft;return{top:t.top+i-r,left:t.left+s-n}}return null}function hide(){for(var e=0;e<this.length;e+=1)this[e].style.display="none";return this}function show(){for(var e=0;e<this.length;e+=1){var t=this[e];"none"===t.style.display&&(t.style.display=""),"none"===win.getComputedStyle(t,null).getPropertyValue("display")&&(t.style.display="block")}return this}function styles(){return this[0]?win.getComputedStyle(this[0],null):{}}function css(e,t){var a;if(1===arguments.length){if("string"!=typeof e){for(a=0;a<this.length;a+=1)for(var r in e)this[a].style[r]=e[r];return this}if(this[0])return win.getComputedStyle(this[0],null).getPropertyValue(e)}if(2===arguments.length&&"string"==typeof e){for(a=0;a<this.length;a+=1)this[a].style[e]=t;return this}return this}function toArray(){for(var e=[],t=0;t<this.length;t+=1)e.push(this[t]);return e}function each(e){if(!e)return this;for(var t=0;t<this.length;t+=1)if(!1===e.call(this[t],t,this[t]))return this;return this}function forEach(e){if(!e)return this;for(var t=0;t<this.length;t+=1)if(!1===e.call(this[t],this[t],t))return this;return this}function filter(e){for(var t=[],a=0;a<this.length;a+=1)e.call(this[a],a,this[a])&&t.push(this[a]);return new Dom7(t)}function map(e){for(var t=[],a=0;a<this.length;a+=1)t.push(e.call(this[a],a,this[a]));return new Dom7(t)}function html(e){if(void 0===e)return this[0]?this[0].innerHTML:void 0;for(var t=0;t<this.length;t+=1)this[t].innerHTML=e;return this}function text(e){if(void 0===e)return this[0]?this[0].textContent.trim():null;for(var t=0;t<this.length;t+=1)this[t].textContent=e;return this}function is(e){var t,a,r=this[0];if(!r||void 0===e)return!1;if("string"==typeof e){if(r.matches)return r.matches(e);if(r.webkitMatchesSelector)return r.webkitMatchesSelector(e);if(r.msMatchesSelector)return r.msMatchesSelector(e);for(t=$(e),a=0;a<t.length;a+=1)if(t[a]===r)return!0;return!1}if(e===doc)return r===doc;if(e===win)return r===win;if(e.nodeType||e instanceof Dom7){for(t=e.nodeType?[e]:e,a=0;a<t.length;a+=1)if(t[a]===r)return!0;return!1}return!1}function indexOf(e){for(var t=0;t<this.length;t+=1)if(this[t]===e)return t;return-1}function index(){var e,t=this[0];if(t){for(e=0;null!==(t=t.previousSibling);)1===t.nodeType&&(e+=1);return e}}function eq(e){if(void 0===e)return this;var t,a=this.length;return new Dom7(e>a-1?[]:e<0?(t=a+e)<0?[]:[this[t]]:[this[e]])}function append(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];for(var r=0;r<t.length;r+=1){e=t[r];for(var n=0;n<this.length;n+=1)if("string"==typeof e){var i=doc.createElement("div");for(i.innerHTML=e;i.firstChild;)this[n].appendChild(i.firstChild)}else if(e instanceof Dom7)for(var s=0;s<e.length;s+=1)this[n].appendChild(e[s]);else this[n].appendChild(e)}return this}function appendTo(e){return $(e).append(this),this}function prepend(e){var t,a;for(t=0;t<this.length;t+=1)if("string"==typeof e){var r=doc.createElement("div");for(r.innerHTML=e,a=r.childNodes.length-1;a>=0;a-=1)this[t].insertBefore(r.childNodes[a],this[t].childNodes[0])}else if(e instanceof Dom7)for(a=0;a<e.length;a+=1)this[t].insertBefore(e[a],this[t].childNodes[0]);else this[t].insertBefore(e,this[t].childNodes[0]);return this}function prependTo(e){return $(e).prepend(this),this}function insertBefore(e){for(var t=$(e),a=0;a<this.length;a+=1)if(1===t.length)t[0].parentNode.insertBefore(this[a],t[0]);else if(t.length>1)for(var r=0;r<t.length;r+=1)t[r].parentNode.insertBefore(this[a].cloneNode(!0),t[r])}function insertAfter(e){for(var t=$(e),a=0;a<this.length;a+=1)if(1===t.length)t[0].parentNode.insertBefore(this[a],t[0].nextSibling);else if(t.length>1)for(var r=0;r<t.length;r+=1)t[r].parentNode.insertBefore(this[a].cloneNode(!0),t[r].nextSibling)}function next(e){return this.length>0?e?this[0].nextElementSibling&&$(this[0].nextElementSibling).is(e)?new Dom7([this[0].nextElementSibling]):new Dom7([]):this[0].nextElementSibling?new Dom7([this[0].nextElementSibling]):new Dom7([]):new Dom7([])}function nextAll(e){var t=[],a=this[0];if(!a)return new Dom7([]);for(;a.nextElementSibling;){var r=a.nextElementSibling;e?$(r).is(e)&&t.push(r):t.push(r),a=r}return new Dom7(t)}function prev(e){if(this.length>0){var t=this[0];return e?t.previousElementSibling&&$(t.previousElementSibling).is(e)?new Dom7([t.previousElementSibling]):new Dom7([]):t.previousElementSibling?new Dom7([t.previousElementSibling]):new Dom7([])}return new Dom7([])}function prevAll(e){var t=[],a=this[0];if(!a)return new Dom7([]);for(;a.previousElementSibling;){var r=a.previousElementSibling;e?$(r).is(e)&&t.push(r):t.push(r),a=r}return new Dom7(t)}function siblings(e){return this.nextAll(e).add(this.prevAll(e))}function parent(e){for(var t=[],a=0;a<this.length;a+=1)null!==this[a].parentNode&&(e?$(this[a].parentNode).is(e)&&t.push(this[a].parentNode):t.push(this[a].parentNode));return $(unique(t))}function parents(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].parentNode;r;)e?$(r).is(e)&&t.push(r):t.push(r),r=r.parentNode;return $(unique(t))}function closest(e){var t=this;return void 0===e?new Dom7([]):(t.is(e)||(t=t.parents(e).eq(0)),t)}function find(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].querySelectorAll(e),n=0;n<r.length;n+=1)t.push(r[n]);return new Dom7(t)}function children(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].childNodes,n=0;n<r.length;n+=1)e?1===r[n].nodeType&&$(r[n]).is(e)&&t.push(r[n]):1===r[n].nodeType&&t.push(r[n]);return new Dom7(unique(t))}function remove(){for(var e=0;e<this.length;e+=1)this[e].parentNode&&this[e].parentNode.removeChild(this[e]);return this}function detach(){return this.remove()}function add(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r;for(a=0;a<e.length;a+=1){var n=$(e[a]);for(r=0;r<n.length;r+=1)this[this.length]=n[r],this.length+=1}return this}function empty(){for(var e=0;e<this.length;e+=1){var t=this[e];if(1===t.nodeType){for(var a=0;a<t.childNodes.length;a+=1)t.childNodes[a].parentNode&&t.childNodes[a].parentNode.removeChild(t.childNodes[a]);t.textContent=""}}return this}$.fn=Dom7.prototype,$.Class=Dom7,$.Dom7=Dom7;var Methods=Object.freeze({addClass:addClass,removeClass:removeClass,hasClass:hasClass,toggleClass:toggleClass,attr:attr,removeAttr:removeAttr,prop:prop,data:data,removeData:removeData,dataset:dataset,val:val,transform:transform,transition:transition,on:on,off:off,once:once,trigger:trigger,transitionEnd:transitionEnd,animationEnd:animationEnd,width:width,outerWidth:outerWidth,height:height,outerHeight:outerHeight,offset:offset,hide:hide,show:show,styles:styles,css:css,toArray:toArray,each:each,forEach:forEach,filter:filter,map:map,html:html,text:text,is:is,indexOf:indexOf,index:index,eq:eq,append:append,appendTo:appendTo,prepend:prepend,prependTo:prependTo,insertBefore:insertBefore,insertAfter:insertAfter,next:next,nextAll:nextAll,prev:prev,prevAll:prevAll,siblings:siblings,parent:parent,parents:parents,closest:closest,find:find,children:children,remove:remove,detach:detach,add:add,empty:empty});function scrollTo(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2],s=t[3],o=t[4];return 4===t.length&&"function"==typeof s&&(o=s,r=(e=t)[0],n=e[1],i=e[2],o=e[3],s=e[4]),void 0===s&&(s="swing"),this.each(function(){var e,t,a,l,p,c,d,u,h=this,f=n>0||0===n,v=r>0||0===r;if(void 0===s&&(s="swing"),f&&(e=h.scrollTop,i||(h.scrollTop=n)),v&&(t=h.scrollLeft,i||(h.scrollLeft=r)),i){f&&(a=h.scrollHeight-h.offsetHeight,p=Math.max(Math.min(n,a),0)),v&&(l=h.scrollWidth-h.offsetWidth,c=Math.max(Math.min(r,l),0));var m=null;f&&p===e&&(f=!1),v&&c===t&&(v=!1),requestAnimationFrame(function a(r){void 0===r&&(r=(new Date).getTime()),null===m&&(m=r);var n,l=Math.max(Math.min((r-m)/i,1),0),g="linear"===s?l:.5-Math.cos(l*Math.PI)/2;f&&(d=e+g*(p-e)),v&&(u=t+g*(c-t)),f&&p>e&&d>=p&&(h.scrollTop=p,n=!0),f&&p<e&&d<=p&&(h.scrollTop=p,n=!0),v&&c>t&&u>=c&&(h.scrollLeft=c,n=!0),v&&c<t&&u<=c&&(h.scrollLeft=c,n=!0),n?o&&o():(f&&(h.scrollTop=d),v&&(h.scrollLeft=u),requestAnimationFrame(a))})}})}function scrollTop(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2],s=t[3];3===t.length&&"function"==typeof i&&(r=(e=t)[0],n=e[1],s=e[2],i=e[3]);return void 0===r?this.length>0?this[0].scrollTop:null:this.scrollTo(void 0,r,n,i,s)}function scrollLeft(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2],s=t[3];3===t.length&&"function"==typeof i&&(r=(e=t)[0],n=e[1],s=e[2],i=e[3]);return void 0===r?this.length>0?this[0].scrollLeft:null:this.scrollTo(r,void 0,n,i,s)}var Scroll=Object.freeze({scrollTo:scrollTo,scrollTop:scrollTop,scrollLeft:scrollLeft});function animate(e,t){var a,r=this,n={props:Object.assign({},e),params:Object.assign({duration:300,easing:"swing"},t),elements:r,animating:!1,que:[],easingProgress:function(e,t){return"swing"===e?.5-Math.cos(t*Math.PI)/2:"function"==typeof e?e(t):t},stop:function(){n.frameId&&cancelAnimationFrame(n.frameId),n.animating=!1,n.elements.each(function(e,t){delete t.dom7AnimateInstance}),n.que=[]},done:function(e){if(n.animating=!1,n.elements.each(function(e,t){delete t.dom7AnimateInstance}),e&&e(r),n.que.length>0){var t=n.que.shift();n.animate(t[0],t[1])}},animate:function(e,t){if(n.animating)return n.que.push([e,t]),n;var a=[];n.elements.each(function(t,r){var i,s,o,l,p;r.dom7AnimateInstance||(n.elements[t].dom7AnimateInstance=n),a[t]={container:r},Object.keys(e).forEach(function(n){i=win.getComputedStyle(r,null).getPropertyValue(n).replace(",","."),s=parseFloat(i),o=i.replace(s,""),l=parseFloat(e[n]),p=e[n]+o,a[t][n]={initialFullValue:i,initialValue:s,unit:o,finalValue:l,finalFullValue:p,currentValue:s}})});var i,s,o=null,l=0,p=0,c=!1;return n.animating=!0,n.frameId=requestAnimationFrame(function d(){var u,h;i=(new Date).getTime(),c||(c=!0,t.begin&&t.begin(r)),null===o&&(o=i),t.progress&&t.progress(r,Math.max(Math.min((i-o)/t.duration,1),0),o+t.duration-i<0?0:o+t.duration-i,o),a.forEach(function(r){var c=r;s||c.done||Object.keys(e).forEach(function(r){if(!s&&!c.done){u=Math.max(Math.min((i-o)/t.duration,1),0),h=n.easingProgress(t.easing,u);var d=c[r],f=d.initialValue,v=d.finalValue,m=d.unit;c[r].currentValue=f+h*(v-f);var g=c[r].currentValue;(v>f&&g>=v||v<f&&g<=v)&&(c.container.style[r]=v+m,(p+=1)===Object.keys(e).length&&(c.done=!0,l+=1),l===a.length&&(s=!0)),s?n.done(t.complete):c.container.style[r]=g+m}})}),s||(n.frameId=requestAnimationFrame(d))}),n}};if(0===n.elements.length)return r;for(var i=0;i<n.elements.length;i+=1)n.elements[i].dom7AnimateInstance?a=n.elements[i].dom7AnimateInstance:n.elements[i].dom7AnimateInstance=n;return a||(a=n),"stop"===e?a.stop():a.animate(n.props,n.params),r}function stop(){for(var e=0;e<this.length;e+=1)this[e].dom7AnimateInstance&&this[e].dom7AnimateInstance.stop()}var Animate=Object.freeze({animate:animate,stop:stop}),noTrigger="resize scroll".split(" ");function eventShortcut(e){for(var t,a=[],r=arguments.length-1;r-- >0;)a[r]=arguments[r+1];if(void 0===a[0]){for(var n=0;n<this.length;n+=1)noTrigger.indexOf(e)<0&&(e in this[n]?this[n][e]():$(this[n]).trigger(e));return this}return(t=this).on.apply(t,[e].concat(a))}function click(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["click"].concat(e))}function blur(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["blur"].concat(e))}function focus(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focus"].concat(e))}function focusin(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focusin"].concat(e))}function focusout(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focusout"].concat(e))}function keyup(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keyup"].concat(e))}function keydown(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keydown"].concat(e))}function keypress(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keypress"].concat(e))}function submit(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["submit"].concat(e))}function change(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["change"].concat(e))}function mousedown(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mousedown"].concat(e))}function mousemove(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mousemove"].concat(e))}function mouseup(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseup"].concat(e))}function mouseenter(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseenter"].concat(e))}function mouseleave(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseleave"].concat(e))}function mouseout(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseout"].concat(e))}function mouseover(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseover"].concat(e))}function touchstart(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchstart"].concat(e))}function touchend(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchend"].concat(e))}function touchmove(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchmove"].concat(e))}function resize(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["resize"].concat(e))}function scroll(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["scroll"].concat(e))}var eventShortcuts=Object.freeze({click:click,blur:blur,focus:focus,focusin:focusin,focusout:focusout,keyup:keyup,keydown:keydown,keypress:keypress,submit:submit,change:change,mousedown:mousedown,mousemove:mousemove,mouseup:mouseup,mouseenter:mouseenter,mouseleave:mouseleave,mouseout:mouseout,mouseover:mouseover,touchstart:touchstart,touchend:touchend,touchmove:touchmove,resize:resize,scroll:scroll});[Methods,Scroll,Animate,eventShortcuts].forEach(function(e){Object.keys(e).forEach(function(t){$.fn[t]=e[t]})});var NEWTON_ITERATIONS=4,NEWTON_MIN_SLOPE=.001,SUBDIVISION_PRECISION=1e-7,SUBDIVISION_MAX_ITERATIONS=10,kSplineTableSize=11,kSampleStepSize=1/(kSplineTableSize-1),float32ArraySupported="function"==typeof Float32Array;function A(e,t){return 1-3*t+3*e}function B(e,t){return 3*t-6*e}function C(e){return 3*e}function calcBezier(e,t,a){return((A(t,a)*e+B(t,a))*e+C(t))*e}function getSlope(e,t,a){return 3*A(t,a)*e*e+2*B(t,a)*e+C(t)}function binarySubdivide(e,t,a,r,n){var i,s,o=0;do{(i=calcBezier(s=t+(a-t)/2,r,n)-e)>0?a=s:t=s}while(Math.abs(i)>SUBDIVISION_PRECISION&&++o<SUBDIVISION_MAX_ITERATIONS);return s}function newtonRaphsonIterate(e,t,a,r){for(var n=0;n<NEWTON_ITERATIONS;++n){var i=getSlope(t,a,r);if(0===i)return t;t-=(calcBezier(t,a,r)-e)/i}return t}function bezier(e,t,a,r){if(!(0<=e&&e<=1&&0<=a&&a<=1))throw new Error("bezier x values must be in [0, 1] range");var n=float32ArraySupported?new Float32Array(kSplineTableSize):new Array(kSplineTableSize);if(e!==t||a!==r)for(var i=0;i<kSplineTableSize;++i)n[i]=calcBezier(i*kSampleStepSize,e,a);return function(i){return e===t&&a===r?i:0===i?0:1===i?1:calcBezier(function(t){for(var r=0,i=1,s=kSplineTableSize-1;i!==s&&n[i]<=t;++i)r+=kSampleStepSize;var o=r+(t-n[--i])/(n[i+1]-n[i])*kSampleStepSize,l=getSlope(o,e,a);return l>=NEWTON_MIN_SLOPE?newtonRaphsonIterate(t,o,e,a):0===l?o:binarySubdivide(t,r,r+kSampleStepSize,e,a)}(i),t,r)}}for(var defaultDiacriticsRemovalap=[{base:"A",letters:"AⒶＡÀÁÂẦẤẪẨÃĀĂẰẮẴẲȦǠÄǞẢÅǺǍȀȂẠẬẶḀĄȺⱯ"},{base:"AA",letters:"Ꜳ"},{base:"AE",letters:"ÆǼǢ"},{base:"AO",letters:"Ꜵ"},{base:"AU",letters:"Ꜷ"},{base:"AV",letters:"ꜸꜺ"},{base:"AY",letters:"Ꜽ"},{base:"B",letters:"BⒷＢḂḄḆɃƂƁ"},{base:"C",letters:"CⒸＣĆĈĊČÇḈƇȻꜾ"},{base:"D",letters:"DⒹＤḊĎḌḐḒḎĐƋƊƉꝹ"},{base:"DZ",letters:"ǱǄ"},{base:"Dz",letters:"ǲǅ"},{base:"E",letters:"EⒺＥÈÉÊỀẾỄỂẼĒḔḖĔĖËẺĚȄȆẸỆȨḜĘḘḚƐƎ"},{base:"F",letters:"FⒻＦḞƑꝻ"},{base:"G",letters:"GⒼＧǴĜḠĞĠǦĢǤƓꞠꝽꝾ"},{base:"H",letters:"HⒽＨĤḢḦȞḤḨḪĦⱧⱵꞍ"},{base:"I",letters:"IⒾＩÌÍÎĨĪĬİÏḮỈǏȈȊỊĮḬƗ"},{base:"J",letters:"JⒿＪĴɈ"},{base:"K",letters:"KⓀＫḰǨḲĶḴƘⱩꝀꝂꝄꞢ"},{base:"L",letters:"LⓁＬĿĹĽḶḸĻḼḺŁȽⱢⱠꝈꝆꞀ"},{base:"LJ",letters:"Ǉ"},{base:"Lj",letters:"ǈ"},{base:"M",letters:"MⓂＭḾṀṂⱮƜ"},{base:"N",letters:"NⓃＮǸŃÑṄŇṆŅṊṈȠƝꞐꞤ"},{base:"NJ",letters:"Ǌ"},{base:"Nj",letters:"ǋ"},{base:"O",letters:"OⓄＯÒÓÔỒỐỖỔÕṌȬṎŌṐṒŎȮȰÖȪỎŐǑȌȎƠỜỚỠỞỢỌỘǪǬØǾƆƟꝊꝌ"},{base:"OI",letters:"Ƣ"},{base:"OO",letters:"Ꝏ"},{base:"OU",letters:"Ȣ"},{base:"OE",letters:"Œ"},{base:"oe",letters:"œ"},{base:"P",letters:"PⓅＰṔṖƤⱣꝐꝒꝔ"},{base:"Q",letters:"QⓆＱꝖꝘɊ"},{base:"R",letters:"RⓇＲŔṘŘȐȒṚṜŖṞɌⱤꝚꞦꞂ"},{base:"S",letters:"SⓈＳẞŚṤŜṠŠṦṢṨȘŞⱾꞨꞄ"},{base:"T",letters:"TⓉＴṪŤṬȚŢṰṮŦƬƮȾꞆ"},{base:"TZ",letters:"Ꜩ"},{base:"U",letters:"UⓊＵÙÚÛŨṸŪṺŬÜǛǗǕǙỦŮŰǓȔȖƯỪỨỮỬỰỤṲŲṶṴɄ"},{base:"V",letters:"VⓋＶṼṾƲꝞɅ"},{base:"VY",letters:"Ꝡ"},{base:"W",letters:"WⓌＷẀẂŴẆẄẈⱲ"},{base:"X",letters:"XⓍＸẊẌ"},{base:"Y",letters:"YⓎＹỲÝŶỸȲẎŸỶỴƳɎỾ"},{base:"Z",letters:"ZⓏＺŹẐŻŽẒẔƵȤⱿⱫꝢ"},{base:"a",letters:"aⓐａẚàáâầấẫẩãāăằắẵẳȧǡäǟảåǻǎȁȃạậặḁąⱥɐ"},{base:"aa",letters:"ꜳ"},{base:"ae",letters:"æǽǣ"},{base:"ao",letters:"ꜵ"},{base:"au",letters:"ꜷ"},{base:"av",letters:"ꜹꜻ"},{base:"ay",letters:"ꜽ"},{base:"b",letters:"bⓑｂḃḅḇƀƃɓ"},{base:"c",letters:"cⓒｃćĉċčçḉƈȼꜿↄ"},{base:"d",letters:"dⓓｄḋďḍḑḓḏđƌɖɗꝺ"},{base:"dz",letters:"ǳǆ"},{base:"e",letters:"eⓔｅèéêềếễểẽēḕḗĕėëẻěȅȇẹệȩḝęḙḛɇɛǝ"},{base:"f",letters:"fⓕｆḟƒꝼ"},{base:"g",letters:"gⓖｇǵĝḡğġǧģǥɠꞡᵹꝿ"},{base:"h",letters:"hⓗｈĥḣḧȟḥḩḫẖħⱨⱶɥ"},{base:"hv",letters:"ƕ"},{base:"i",letters:"iⓘｉìíîĩīĭïḯỉǐȉȋịįḭɨı"},{base:"j",letters:"jⓙｊĵǰɉ"},{base:"k",letters:"kⓚｋḱǩḳķḵƙⱪꝁꝃꝅꞣ"},{base:"l",letters:"lⓛｌŀĺľḷḹļḽḻſłƚɫⱡꝉꞁꝇ"},{base:"lj",letters:"ǉ"},{base:"m",letters:"mⓜｍḿṁṃɱɯ"},{base:"n",letters:"nⓝｎǹńñṅňṇņṋṉƞɲŉꞑꞥ"},{base:"nj",letters:"ǌ"},{base:"o",letters:"oⓞｏòóôồốỗổõṍȭṏōṑṓŏȯȱöȫỏőǒȍȏơờớỡởợọộǫǭøǿɔꝋꝍɵ"},{base:"oi",letters:"ƣ"},{base:"ou",letters:"ȣ"},{base:"oo",letters:"ꝏ"},{base:"p",letters:"pⓟｐṕṗƥᵽꝑꝓꝕ"},{base:"q",letters:"qⓠｑɋꝗꝙ"},{base:"r",letters:"rⓡｒŕṙřȑȓṛṝŗṟɍɽꝛꞧꞃ"},{base:"s",letters:"sⓢｓßśṥŝṡšṧṣṩșşȿꞩꞅẛ"},{base:"t",letters:"tⓣｔṫẗťṭțţṱṯŧƭʈⱦꞇ"},{base:"tz",letters:"ꜩ"},{base:"u",letters:"uⓤｕùúûũṹūṻŭüǜǘǖǚủůűǔȕȗưừứữửựụṳųṷṵʉ"},{base:"v",letters:"vⓥｖṽṿʋꝟʌ"},{base:"vy",letters:"ꝡ"},{base:"w",letters:"wⓦｗẁẃŵẇẅẘẉⱳ"},{base:"x",letters:"xⓧｘẋẍ"},{base:"y",letters:"yⓨｙỳýŷỹȳẏÿỷẙỵƴɏỿ"},{base:"z",letters:"zⓩｚźẑżžẓẕƶȥɀⱬꝣ"}],diacriticsMap={},i=0;i<defaultDiacriticsRemovalap.length;i+=1)for(var letters=defaultDiacriticsRemovalap[i].letters,j=0;j<letters.length;j+=1)diacriticsMap[letters[j]]=defaultDiacriticsRemovalap[i].base;var uniqueNumber=1,Utils={uniqueNumber:function(){return uniqueNumber+=1},id:function(e,t){void 0===e&&(e="xxxxxxxxxx"),void 0===t&&(t="0123456789abcdef");var a=t.length;return e.replace(/x/g,function(){return t[Math.floor(Math.random()*a)]})},mdPreloaderContent:'\n    <span class="preloader-inner">\n      <span class="preloader-inner-gap"></span>\n      <span class="preloader-inner-left">\n          <span class="preloader-inner-half-circle"></span>\n      </span>\n      <span class="preloader-inner-right">\n          <span class="preloader-inner-half-circle"></span>\n      </span>\n    </span>\n  '.trim(),iosPreloaderContent:('\n    <span class="preloader-inner">\n      '+[0,1,2,3,4,5,6,7,8,9,10,11].map(function(){return'<span class="preloader-inner-line"></span>'}).join("")+"\n    </span>\n  ").trim(),auroraPreloaderContent:'\n    <span class="preloader-inner">\n      <span class="preloader-inner-circle"></span>\n    </span>\n  ',eventNameToColonCase:function(e){var t;return e.split("").map(function(e,a){return e.match(/[A-Z]/)&&0!==a&&!t?(t=!0,":"+e.toLowerCase()):e.toLowerCase()}).join("")},deleteProps:function(e){var t=e;Object.keys(t).forEach(function(e){try{t[e]=null}catch(e){}try{delete t[e]}catch(e){}})},bezier:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return bezier.apply(void 0,e)},nextTick:function(e,t){return void 0===t&&(t=0),setTimeout(e,t)},nextFrame:function(e){return Utils.requestAnimationFrame(function(){Utils.requestAnimationFrame(e)})},now:function(){return Date.now()},requestAnimationFrame:function(e){return win.requestAnimationFrame(e)},cancelAnimationFrame:function(e){return win.cancelAnimationFrame(e)},removeDiacritics:function(e){return e.replace(/[^\u0000-\u007E]/g,function(e){return diacriticsMap[e]||e})},parseUrlQuery:function(e){var t,a,r,n,i={},s=e||win.location.href;if("string"==typeof s&&s.length)for(n=(a=(s=s.indexOf("?")>-1?s.replace(/\S*\?/,""):"").split("&").filter(function(e){return""!==e})).length,t=0;t<n;t+=1)r=a[t].replace(/#\S+/g,"").split("="),i[decodeURIComponent(r[0])]=void 0===r[1]?void 0:decodeURIComponent(r.slice(1).join("="))||"";return i},getTranslate:function(e,t){var a,r,n;void 0===t&&(t="x");var i=win.getComputedStyle(e,null);return win.WebKitCSSMatrix?((r=i.transform||i.webkitTransform).split(",").length>6&&(r=r.split(", ").map(function(e){return e.replace(",",".")}).join(", ")),n=new win.WebKitCSSMatrix("none"===r?"":r)):a=(n=i.MozTransform||i.OTransform||i.MsTransform||i.msTransform||i.transform||i.getPropertyValue("transform").replace("translate(","matrix(1, 0, 0, 1,")).toString().split(","),"x"===t&&(r=win.WebKitCSSMatrix?n.m41:16===a.length?parseFloat(a[12]):parseFloat(a[4])),"y"===t&&(r=win.WebKitCSSMatrix?n.m42:16===a.length?parseFloat(a[13]):parseFloat(a[5])),r||0},serializeObject:function(e,t){if(void 0===t&&(t=[]),"string"==typeof e)return e;var a,r=[];function n(e){if(t.length>0){for(var a="",r=0;r<t.length;r+=1)a+=0===r?t[r]:"["+encodeURIComponent(t[r])+"]";return a+"["+encodeURIComponent(e)+"]"}return encodeURIComponent(e)}function i(e){return encodeURIComponent(e)}return Object.keys(e).forEach(function(s){var o;if(Array.isArray(e[s])){o=[];for(var l=0;l<e[s].length;l+=1)Array.isArray(e[s][l])||"object"!=typeof e[s][l]?o.push(n(s)+"[]="+i(e[s][l])):((a=t.slice()).push(s),a.push(String(l)),o.push(Utils.serializeObject(e[s][l],a)));o.length>0&&r.push(o.join("&"))}else null===e[s]||""===e[s]?r.push(n(s)+"="):"object"==typeof e[s]?((a=t.slice()).push(s),""!==(o=Utils.serializeObject(e[s],a))&&r.push(o)):void 0!==e[s]&&""!==e[s]?r.push(n(s)+"="+i(e[s])):""===e[s]&&r.push(n(s))}),r.join("&")},isObject:function(e){return"object"==typeof e&&null!==e&&e.constructor&&e.constructor===Object},merge:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a=e[0];e.splice(0,1);for(var r=e,n=0;n<r.length;n+=1){var i=e[n];if(null!=i)for(var s=Object.keys(Object(i)),o=0,l=s.length;o<l;o+=1){var p=s[o],c=Object.getOwnPropertyDescriptor(i,p);void 0!==c&&c.enumerable&&(a[p]=i[p])}}return a},extend:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,n=!0;"boolean"==typeof e[0]?(n=e[0],a=e[1],e.splice(0,2),r=e):(a=e[0],e.splice(0,1),r=e);for(var i=0;i<r.length;i+=1){var s=e[i];if(null!=s)for(var o=Object.keys(Object(s)),l=0,p=o.length;l<p;l+=1){var c=o[l],d=Object.getOwnPropertyDescriptor(s,c);void 0!==d&&d.enumerable&&(n?Utils.isObject(a[c])&&Utils.isObject(s[c])?Utils.extend(a[c],s[c]):!Utils.isObject(a[c])&&Utils.isObject(s[c])?(a[c]={},Utils.extend(a[c],s[c])):a[c]=s[c]:a[c]=s[c])}}return a},colorHexToRgb:function(e){var t=e.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i,function(e,t,a,r){return t+t+a+a+r+r}),a=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(t);return a?a.slice(1).map(function(e){return parseInt(e,16)}):null},colorRgbToHex:function(e,t,a){return"#"+[e,t,a].map(function(e){var t=e.toString(16);return 1===t.length?"0"+t:t}).join("")},colorRgbToHsl:function(e,t,a){e/=255,t/=255,a/=255;var r,n=Math.max(e,t,a),i=Math.min(e,t,a),s=n-i;0===s?r=0:n===e?r=(t-a)/s%6:n===t?r=(a-e)/s+2:n===a&&(r=(e-t)/s+4);var o=(i+n)/2;return[60*r,0===s?0:s/(1-Math.abs(2*o-1)),o]},colorHslToRgb:function(e,t,a){var r,n=(1-Math.abs(2*a-1))*t,i=e/60,s=n*(1-Math.abs(i%2-1));Number.isNaN(e)||void 0===e?r=[0,0,0]:i<=1?r=[n,s,0]:i<=2?r=[s,n,0]:i<=3?r=[0,n,s]:i<=4?r=[0,s,n]:i<=5?r=[s,0,n]:i<=6&&(r=[n,0,s]);var o=a-n/2;return r.map(function(e){return Math.max(0,Math.min(255,Math.round(255*(e+o))))})},colorThemeCSSProperties:function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];if(1===a.length?(e=a[0],t=Utils.colorHexToRgb(e)):3===a.length&&(t=a,e=Utils.colorRgbToHex.apply(Utils,t)),!t)return{};var n=Utils.colorRgbToHsl.apply(Utils,t),i=[n[0],n[1],Math.max(0,n[2]-.08)],s=[n[0],n[1],Math.max(0,n[2]+.08)],o=Utils.colorRgbToHex.apply(Utils,Utils.colorHslToRgb.apply(Utils,i)),l=Utils.colorRgbToHex.apply(Utils,Utils.colorHslToRgb.apply(Utils,s));return{"--f7-theme-color":e,"--f7-theme-color-rgb":t.join(", "),"--f7-theme-color-shade":o,"--f7-theme-color-tint":l}}},Device=function(){var e=win.navigator.platform,t=win.navigator.userAgent,a={ios:!1,android:!1,androidChrome:!1,desktop:!1,windowsPhone:!1,iphone:!1,iphoneX:!1,ipod:!1,ipad:!1,edge:!1,ie:!1,firefox:!1,macos:!1,windows:!1,cordova:!(!win.cordova&&!win.phonegap),phonegap:!(!win.cordova&&!win.phonegap),electron:!1},r=win.screen.width,n=win.screen.height,i=t.match(/(Windows Phone);?[\s\/]+([\d.]+)?/),s=t.match(/(Android);?[\s\/]+([\d.]+)?/),o=t.match(/(iPad).*OS\s([\d_]+)/),l=t.match(/(iPod)(.*OS\s([\d_]+))?/),p=!o&&t.match(/(iPhone\sOS|iOS)\s([\d_]+)/),c=p&&(375===r&&812===n||414===r&&896===n),d=t.indexOf("MSIE ")>=0||t.indexOf("Trident/")>=0,u=t.indexOf("Edge/")>=0,h=t.indexOf("Gecko/")>=0&&t.indexOf("Firefox/")>=0,f="MacIntel"===e,v="Win32"===e,m=t.toLowerCase().indexOf("electron")>=0;a.ie=d,a.edge=u,a.firefox=h,i&&(a.os="windowsPhone",a.osVersion=i[2],a.windowsPhone=!0),s&&!v&&(a.os="android",a.osVersion=s[2],a.android=!0,a.androidChrome=t.toLowerCase().indexOf("chrome")>=0),(o||p||l)&&(a.os="ios",a.ios=!0),p&&!l&&(a.osVersion=p[2].replace(/_/g,"."),a.iphone=!0,a.iphoneX=c),o&&(a.osVersion=o[2].replace(/_/g,"."),a.ipad=!0),l&&(a.osVersion=l[3]?l[3].replace(/_/g,"."):null,a.iphone=!0),a.ios&&a.osVersion&&t.indexOf("Version/")>=0&&"10"===a.osVersion.split(".")[0]&&(a.osVersion=t.toLowerCase().split("version/")[1].split(" ")[0]),a.webView=!(!(p||o||l)||!t.match(/.*AppleWebKit(?!.*Safari)/i)&&!win.navigator.standalone)||win.matchMedia&&win.matchMedia("(display-mode: standalone)").matches,a.webview=a.webView,a.standalone=a.webView,a.desktop=!(a.ios||a.android||a.windowsPhone)||m,a.desktop&&(a.electron=m,a.macos=f,a.windows=v);var g=doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');return a.needsStatusbarOverlay=function(){return!a.desktop&&(!!(a.standalone&&a.ios&&g&&"black-translucent"===g.content)||!(!(a.webView||a.android&&a.cordova)||win.innerWidth*win.innerHeight!=win.screen.width*win.screen.height)&&(!a.iphoneX||90!==win.orientation&&-90!==win.orientation))},a.statusbar=a.needsStatusbarOverlay(),a.pixelRatio=win.devicePixelRatio||1,a}(),EventsClass=function(e){void 0===e&&(e=[]);this.eventsParents=e,this.eventsListeners={}};EventsClass.prototype.on=function(e,t,a){var r=this;if("function"!=typeof t)return r;var n=a?"unshift":"push";return e.split(" ").forEach(function(e){r.eventsListeners[e]||(r.eventsListeners[e]=[]),r.eventsListeners[e][n](t)}),r},EventsClass.prototype.once=function(e,t,a){var r=this;if("function"!=typeof t)return r;function n(){for(var a=[],i=arguments.length;i--;)a[i]=arguments[i];t.apply(r,a),r.off(e,n),n.f7proxy&&delete n.f7proxy}return n.f7proxy=t,r.on(e,n,a)},EventsClass.prototype.off=function(e,t){var a=this;return a.eventsListeners?(e.split(" ").forEach(function(e){void 0===t?a.eventsListeners[e]=[]:a.eventsListeners[e]&&a.eventsListeners[e].forEach(function(r,n){(r===t||r.f7proxy&&r.f7proxy===t)&&a.eventsListeners[e].splice(n,1)})}),a):a},EventsClass.prototype.emit=function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,n,i,s=this;if(!s.eventsListeners)return s;"string"==typeof e[0]||Array.isArray(e[0])?(a=e[0],r=e.slice(1,e.length),n=s,i=s.eventsParents):(a=e[0].events,r=e[0].data,n=e[0].context||s,i=e[0].local?[]:e[0].parents||s.eventsParents);var o=Array.isArray(a)?a:a.split(" "),l=o.map(function(e){return e.replace("local::","")}),p=o.filter(function(e){return e.indexOf("local::")<0});return l.forEach(function(e){if(s.eventsListeners&&s.eventsListeners[e]){var t=[];s.eventsListeners[e].forEach(function(e){t.push(e)}),t.forEach(function(e){e.apply(n,r)})}}),i&&i.length>0&&i.forEach(function(e){e.emit.apply(e,[p].concat(r))}),s};var Framework7Class=function(e){function t(t,a){void 0===t&&(t={}),void 0===a&&(a=[]),e.call(this,a);var r=this;r.params=t,r.params&&r.params.on&&Object.keys(r.params.on).forEach(function(e){r.on(e,r.params.on[e])})}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={components:{configurable:!0}};return t.prototype.useModuleParams=function(e,t){if(e.params){var a={};Object.keys(e.params).forEach(function(e){void 0!==t[e]&&(a[e]=Utils.extend({},t[e]))}),Utils.extend(t,e.params),Object.keys(a).forEach(function(e){Utils.extend(t[e],a[e])})}},t.prototype.useModulesParams=function(e){var t=this;t.modules&&Object.keys(t.modules).forEach(function(a){var r=t.modules[a];r.params&&Utils.extend(e,r.params)})},t.prototype.useModule=function(e,t){void 0===e&&(e=""),void 0===t&&(t={});var a=this;if(a.modules){var r="string"==typeof e?a.modules[e]:e;r&&(r.instance&&Object.keys(r.instance).forEach(function(e){var t=r.instance[e];a[e]="function"==typeof t?t.bind(a):t}),r.on&&a.on&&Object.keys(r.on).forEach(function(e){a.on(e,r.on[e])}),r.vnode&&(a.vnodeHooks||(a.vnodeHooks={}),Object.keys(r.vnode).forEach(function(e){Object.keys(r.vnode[e]).forEach(function(t){var n=r.vnode[e][t];a.vnodeHooks[t]||(a.vnodeHooks[t]={}),a.vnodeHooks[t][e]||(a.vnodeHooks[t][e]=[]),a.vnodeHooks[t][e].push(n.bind(a))})})),r.create&&r.create.bind(a)(t))}},t.prototype.useModules=function(e){void 0===e&&(e={});var t=this;t.modules&&Object.keys(t.modules).forEach(function(a){var r=e[a]||{};t.useModule(a,r)})},a.components.set=function(e){this.use&&this.use(e)},t.installModule=function(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=this;r.prototype.modules||(r.prototype.modules={});var n=e.name||Object.keys(r.prototype.modules).length+"_"+Utils.now();return r.prototype.modules[n]=e,e.proto&&Object.keys(e.proto).forEach(function(t){r.prototype[t]=e.proto[t]}),e.static&&Object.keys(e.static).forEach(function(t){r[t]=e.static[t]}),e.install&&e.install.apply(r,t),r},t.use=function(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=this;return Array.isArray(e)?(e.forEach(function(e){return r.installModule(e)}),r):r.installModule.apply(r,[e].concat(t))},Object.defineProperties(t,a),t}(EventsClass);function ConstructorMethods(e){void 0===e&&(e={});var t=e.defaultSelector,a=e.constructor,r=e.domProp,n=e.app,i=e.addMethods,s={create:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return n?new(Function.prototype.bind.apply(a,[null].concat([n],e))):new(Function.prototype.bind.apply(a,[null].concat(e)))},get:function(e){if(void 0===e&&(e=t),e instanceof a)return e;var n=$(e);return 0!==n.length?n[0][r]:void 0},destroy:function(e){var t=s.get(e);if(t&&t.destroy)return t.destroy()}};return i&&Array.isArray(i)&&i.forEach(function(e){s[e]=function(a){void 0===a&&(a=t);for(var r=[],n=arguments.length-1;n-- >0;)r[n]=arguments[n+1];var i=s.get(a);if(i&&i[e])return i[e].apply(i,r)}}),s}function ModalMethods(e){void 0===e&&(e={});var t=e.defaultSelector,a=e.constructor,r=e.app;return Utils.extend(ConstructorMethods({defaultSelector:t,constructor:a,app:r,domProp:"f7Modal"}),{open:function(e,t){var n=$(e),i=n[0].f7Modal;return i||(i=new a(r,{el:n})),i.open(t)},close:function(e,n){void 0===e&&(e=t);var i=$(e);if(0!==i.length){var s=i[0].f7Modal;return s||(s=new a(r,{el:i})),s.close(n)}}})}var fetchedModules=[];function loadModule(e){var t=this;return new Promise(function(a,r){var n,i,s,o=t.instance;if(e){if("string"==typeof e){var l=e.match(/([a-z0-9-]*)/i);if(e.indexOf(".")<0&&l&&l[0].length===e.length){if(!o||o&&!o.params.lazyModulesPath)return void r(new Error('Framework7: "lazyModulesPath" app parameter must be specified to fetch module by name'));n=o.params.lazyModulesPath+"/"+e+".js"}else n=e}else"function"==typeof e?s=e:i=e;if(s){var p=s(t,!1);if(!p)return void r(new Error("Framework7: Can't find Framework7 component in specified component function"));if(t.prototype.modules&&t.prototype.modules[p.name])return void a();h(p),a()}if(i){var c=i;if(!c)return void r(new Error("Framework7: Can't find Framework7 component in specified component"));if(t.prototype.modules&&t.prototype.modules[c.name])return void a();h(c),a()}if(n){if(fetchedModules.indexOf(n)>=0)return void a();fetchedModules.push(n);var d=new Promise(function(e,a){t.request.get(n,function(r){var i="f7_component_loader_callback_"+Utils.id(),s=document.createElement("script");s.innerHTML="window."+i+" = function (Framework7, Framework7AutoInstallComponent) {return "+r.trim()+"}",$("head").append(s);var o=window[i];delete window[i],$(s).remove();var l=o(t,!1);l?t.prototype.modules&&t.prototype.modules[l.name]?e():(h(l),e()):a(new Error("Framework7: Can't find Framework7 component in "+n+" file"))},function(e,t){a(e,t)})}),u=new Promise(function(e){t.request.get(n.replace(".js",o.rtl?".rtl.css":".css"),function(t){var a=document.createElement("style");a.innerHTML=t,$("head").append(a),e()},function(){e()})});Promise.all([d,u]).then(function(){a()}).catch(function(e){r(e)})}}else r(new Error("Framework7: Lazy module must be specified"));function h(e){t.use(e),o&&(o.useModuleParams(e,o.params),o.useModule(e))}})}var Framework7=function(e){function t(a){if(e.call(this,a),t.instance)throw new Error("Framework7 is already initialized and can't be initialized more than once");var r=Utils.extend({},a),n=this;t.instance=n;var i={version:"1.0.0",id:"io.framework7.testapp",root:"body",theme:"auto",language:win.navigator.language,routes:[],name:"Framework7",lazyModulesPath:null,initOnDeviceReady:!0,init:!0};n.useModulesParams(i),n.params=Utils.extend(i,a);var s=$(n.params.root);return Utils.extend(n,{id:n.params.id,name:n.params.name,version:n.params.version,routes:n.params.routes,language:n.params.language,root:s,rtl:"rtl"===s.css("direction"),theme:"auto"===n.params.theme?Device.ios?"ios":Device.desktop&&Device.electron?"aurora":"md":n.params.theme,passedParams:r}),n.root&&n.root[0]&&(n.root[0].f7=n),n.useModules(),n.initData(),n.params.init&&(Device.cordova&&n.params.initOnDeviceReady?$(doc).on("deviceready",function(){n.init()}):n.init()),n}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={$:{configurable:!0},t7:{configurable:!0}},r={Dom7:{configurable:!0},$:{configurable:!0},Template7:{configurable:!0},Class:{configurable:!0},Events:{configurable:!0}};return t.prototype.initData=function(){var e=this;e.data={},e.params.data&&"function"==typeof e.params.data?Utils.extend(e.data,e.params.data.bind(e)()):e.params.data&&Utils.extend(e.data,e.params.data),e.methods={},e.params.methods&&Object.keys(e.params.methods).forEach(function(t){"function"==typeof e.params.methods[t]?e.methods[t]=e.params.methods[t].bind(e):e.methods[t]=e.params.methods[t]})},t.prototype.init=function(){var e=this;return e.initialized?e:(e.root.addClass("framework7-initializing"),e.rtl&&$("html").attr("dir","rtl"),e.root.addClass("framework7-root"),$("html").removeClass("ios md").addClass(e.theme),Utils.nextFrame(function(){e.root.removeClass("framework7-initializing")}),e.initialized=!0,e.emit("init"),e)},t.prototype.loadModule=function(){for(var e=[],a=arguments.length;a--;)e[a]=arguments[a];return t.loadModule.apply(t,e)},t.prototype.loadModules=function(){for(var e=[],a=arguments.length;a--;)e[a]=arguments[a];return t.loadModules.apply(t,e)},t.prototype.getVnodeHooks=function(e,t){return this.vnodeHooks&&this.vnodeHooks[e]&&this.vnodeHooks[e][t]||[]},a.$.get=function(){return $},a.t7.get=function(){return Template7},r.Dom7.get=function(){return $},r.$.get=function(){return $},r.Template7.get=function(){return Template7},r.Class.get=function(){return e},r.Events.get=function(){return EventsClass},Object.defineProperties(t.prototype,a),Object.defineProperties(t,r),t}(Framework7Class);Framework7.ModalMethods=ModalMethods,Framework7.ConstructorMethods=ConstructorMethods,Framework7.loadModule=loadModule,Framework7.loadModules=function(e){return Promise.all(e.map(function(e){return Framework7.loadModule(e)}))};var DeviceModule={name:"device",proto:{device:Device},static:{device:Device},on:{init:function(){var e=[],t=doc.querySelector("html"),a=doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(t){if(Device.standalone&&Device.ios&&a&&"black-translucent"===a.content&&e.push("device-full-viewport"),e.push("device-pixel-ratio-"+Math.floor(Device.pixelRatio)),Device.pixelRatio>=2&&e.push("device-retina"),Device.os){if(e.push("device-"+Device.os,"device-"+Device.os+"-"+Device.osVersion.split(".")[0],"device-"+Device.os+"-"+Device.osVersion.replace(/\./g,"-")),"ios"===Device.os){for(var r=parseInt(Device.osVersion.split(".")[0],10)-1;r>=6;r-=1)e.push("device-ios-gt-"+r);Device.iphoneX&&e.push("device-iphone-x")}}else Device.desktop&&(e.push("device-desktop"),Device.macos?e.push("device-macos"):Device.windows&&e.push("device-windows"));(Device.cordova||Device.phonegap)&&e.push("device-cordova"),e.forEach(function(e){t.classList.add(e)})}}}},Support=(testDiv=doc.createElement("div"),{touch:!!(win.navigator.maxTouchPoints>0||"ontouchstart"in win||win.DocumentTouch&&doc instanceof win.DocumentTouch),pointerEvents:!!(win.navigator.pointerEnabled||win.PointerEvent||"maxTouchPoints"in win.navigator&&win.navigator.maxTouchPoints>0),prefixedPointerEvents:!!win.navigator.msPointerEnabled,transition:(style=testDiv.style,"transition"in style||"webkitTransition"in style||"MozTransition"in style),transforms3d:win.Modernizr&&!0===win.Modernizr.csstransforms3d||function(){var e=testDiv.style;return"webkitPerspective"in e||"MozPerspective"in e||"OPerspective"in e||"MsPerspective"in e||"perspective"in e}(),flexbox:function(){for(var e=doc.createElement("div").style,t="alignItems webkitAlignItems webkitBoxAlign msFlexAlign mozBoxAlign webkitFlexDirection msFlexDirection mozBoxDirection mozBoxOrient webkitBoxDirection webkitBoxOrient".split(" "),a=0;a<t.length;a+=1)if(t[a]in e)return!0;return!1}(),observer:"MutationObserver"in win||"WebkitMutationObserver"in win,passiveListener:function(){var e=!1;try{var t=Object.defineProperty({},"passive",{get:function(){e=!0}});win.addEventListener("testPassiveListener",null,t)}catch(e){}return e}(),gestures:"ongesturestart"in win,intersectionObserver:"IntersectionObserver"in win}),style,testDiv,SupportModule={name:"support",proto:{support:Support},static:{support:Support},on:{init:function(){var e=doc.querySelector("html");if(e){[].forEach(function(t){e.classList.add(t)})}}}},UtilsModule={name:"utils",proto:{utils:Utils},static:{utils:Utils}},ResizeModule={name:"resize",instance:{getSize:function(){if(!this.root[0])return{width:0,height:0,left:0,top:0};var e=this.root.offset(),t=[this.root[0].offsetWidth,this.root[0].offsetHeight,e.left,e.top],a=t[0],r=t[1],n=t[2],i=t[3];return this.width=a,this.height=r,this.left=n,this.top=i,{width:a,height:r,left:n,top:i}}},on:{init:function(){var e=this;e.getSize(),win.addEventListener("resize",function(){e.emit("resize")},!1),win.addEventListener("orientationchange",function(){e.emit("orientationchange")})},orientationchange:function(){this.device.ipad&&(doc.body.scrollLeft=0,setTimeout(function(){doc.body.scrollLeft=0},0))},resize:function(){this.getSize()}}},globals={},jsonpRequests=0;function Request(e){var t=Utils.extend({},globals);"beforeCreate beforeOpen beforeSend error complete success statusCode".split(" ").forEach(function(e){delete t[e]});var a=Utils.extend({url:win.location.toString(),method:"GET",data:!1,async:!0,cache:!0,user:"",password:"",headers:{},xhrFields:{},statusCode:{},processData:!0,dataType:"text",contentType:"application/x-www-form-urlencoded",timeout:0},t),r=Utils.extend({},a,e);function n(e){for(var t,a,n=[],i=arguments.length-1;i-- >0;)n[i]=arguments[i+1];return globals[e]&&(t=globals[e].apply(globals,n)),r[e]&&(a=r[e].apply(r,n)),"boolean"!=typeof t&&(t=!0),"boolean"!=typeof a&&(a=!0),t&&a}if(!1!==n("beforeCreate",r)){r.type&&(r.method=r.type);var i,s=r.url.indexOf("?")>=0?"&":"?",o=r.method.toUpperCase();if(("GET"===o||"HEAD"===o||"OPTIONS"===o||"DELETE"===o)&&r.data)(i="string"==typeof r.data?r.data.indexOf("?")>=0?r.data.split("?")[1]:r.data:Utils.serializeObject(r.data)).length&&(r.url+=s+i,"?"===s&&(s="&"));if("json"===r.dataType&&r.url.indexOf("callback=")>=0){var l,p="f7jsonp_"+(Date.now()+(jsonpRequests+=1)),c=r.url.split("callback="),d=c[0]+"callback="+p;if(c[1].indexOf("&")>=0){var u=c[1].split("&").filter(function(e){return e.indexOf("=")>0}).join("&");u.length>0&&(d+="&"+u)}var h=doc.createElement("script");return h.type="text/javascript",h.onerror=function(){clearTimeout(l),n("error",null,"scripterror"),n("complete",null,"scripterror")},h.src=d,win[p]=function(e){clearTimeout(l),n("success",e),h.parentNode.removeChild(h),h=null,delete win[p]},doc.querySelector("head").appendChild(h),void(r.timeout>0&&(l=setTimeout(function(){h.parentNode.removeChild(h),h=null,n("error",null,"timeout")},r.timeout)))}"GET"!==o&&"HEAD"!==o&&"OPTIONS"!==o&&"DELETE"!==o||!1===r.cache&&(r.url+=s+"_nocache"+Date.now());var f=new XMLHttpRequest;if(f.requestUrl=r.url,f.requestParameters=r,!1===n("beforeOpen",f,r))return f;f.open(o,r.url,r.async,r.user,r.password);var v,m=null;if(("POST"===o||"PUT"===o||"PATCH"===o)&&r.data)if(r.processData)if([ArrayBuffer,Blob,Document,FormData].indexOf(r.data.constructor)>=0)m=r.data;else{var g="---------------------------"+Date.now().toString(16);"multipart/form-data"===r.contentType?f.setRequestHeader("Content-Type","multipart/form-data; boundary="+g):f.setRequestHeader("Content-Type",r.contentType),m="";var b=Utils.serializeObject(r.data);if("multipart/form-data"===r.contentType){b=b.split("&");for(var y=[],w=0;w<b.length;w+=1)y.push('Content-Disposition: form-data; name="'+b[w].split("=")[0]+'"\r\n\r\n'+b[w].split("=")[1]+"\r\n");m="--"+g+"\r\n"+y.join("--"+g+"\r\n")+"--"+g+"--\r\n"}else m="application/json"===r.contentType?JSON.stringify(r.data):b}else m=r.data,f.setRequestHeader("Content-Type",r.contentType);return r.headers&&Object.keys(r.headers).forEach(function(e){f.setRequestHeader(e,r.headers[e])}),void 0===r.crossDomain&&(r.crossDomain=/^([\w-]+:)?\/\/([^\/]+)/.test(r.url)&&RegExp.$2!==win.location.host),r.crossDomain||f.setRequestHeader("X-Requested-With","XMLHttpRequest"),r.xhrFields&&Utils.extend(f,r.xhrFields),f.onload=function(){var e;if(v&&clearTimeout(v),f.status>=200&&f.status<300||0===f.status)if("json"===r.dataType){var t;try{e=JSON.parse(f.responseText)}catch(e){t=!0}t?n("error",f,"parseerror"):n("success",e,f.status,f)}else n("success",e="text"===f.responseType||""===f.responseType?f.responseText:f.response,f.status,f);else n("error",f,f.status);r.statusCode&&(globals.statusCode&&globals.statusCode[f.status]&&globals.statusCode[f.status](f),r.statusCode[f.status]&&r.statusCode[f.status](f)),n("complete",f,f.status)},f.onerror=function(){v&&clearTimeout(v),n("error",f,f.status),n("complete",f,"error")},r.timeout>0&&(f.onabort=function(){v&&clearTimeout(v)},v=setTimeout(function(){f.abort(),n("error",f,"timeout"),n("complete",f,"timeout")},r.timeout)),!1===n("beforeSend",f,r)?f:(f.send(m),f)}}function RequestShortcut(e){for(var t,a,r=[],n=arguments.length-1;n-- >0;)r[n]=arguments[n+1];var i=[],s=i[0],o=i[1],l=i[2],p=i[3],c=i[4];"function"==typeof r[1]?(s=(t=r)[0],l=t[1],p=t[2],c=t[3]):(s=(a=r)[0],o=a[1],l=a[2],p=a[3],c=a[4]),[l,p].forEach(function(e){"string"==typeof e&&(c=e,e===l?l=void 0:p=void 0)});var d={url:s,method:"post"===e||"postJSON"===e?"POST":"GET",data:o,success:l,error:p,dataType:c=c||("json"===e||"postJSON"===e?"json":void 0)};return"postJSON"===e&&Utils.extend(d,{contentType:"application/json",processData:!1,crossDomain:!0,data:"string"==typeof o?o:JSON.stringify(o)}),Request(d)}function RequestShortcutPromise(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=t[0],n=t[1],i=t[2];return new Promise(function(t,a){RequestShortcut(e,r,n,function(e){t(e)},function(e,t){a(t)},i)})}Object.assign(Request,{get:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["get"].concat(e))},post:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["post"].concat(e))},json:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["json"].concat(e))},getJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["json"].concat(e))},postJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["postJSON"].concat(e))}}),Request.promise=function(e){return new Promise(function(t,a){Request(Object.assign(e,{success:function(e){t(e)},error:function(e,t){a(t)}}))})},Object.assign(Request.promise,{get:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["get"].concat(e))},post:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["post"].concat(e))},json:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["json"].concat(e))},getJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["json"].concat(e))},postJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["postJSON"].concat(e))}}),Request.setup=function(e){e.type&&!e.method&&Utils.extend(e,{method:e.type}),Utils.extend(globals,e)};var RequestModule={name:"request",proto:{request:Request},static:{request:Request}};function initTouch(){var e,t,a,r,n,i,s,o,l,p,c,d,u,h,f,v,m,g,b,y=this,w=y.params.touch,C=w[y.theme+"TouchRipple"];function x(e){var t,a=$(e),r=a.parents(w.activeStateElements);if(a.is(w.activeStateElements)&&(t=a),r.length>0&&(t=t?t.add(r):r),t&&t.length>1){for(var n,i=[],s=0;s<t.length;s+=1)n||(i.push(t[s]),(t.eq(s).hasClass("prevent-active-state-propagation")||t.eq(s).hasClass("no-active-state-propagation"))&&(n=!0));t=$(i)}return t||a}function E(e){return e.parents(".page-content").length>0}function k(){u&&u.addClass("active-state")}function S(){u&&(u.removeClass("active-state"),u=null)}function T(e,t,a){e&&(m=y.touchRipple.create(e,t,a))}function M(){m&&(m.remove(),m=void 0,g=void 0)}function P(a){(g=function(e){var t=w.touchRippleElements,a=$(e);if(a.is(t))return!a.hasClass("no-ripple")&&a;if(a.parents(t).length>0){var r=a.parents(t).eq(0);return!r.hasClass("no-ripple")&&r}return!1}(a))&&0!==g.length?(w.fastClicks?function(e){var t=e.parents(".page-content");return 0!==t.length&&("yes"!==t.prop("scrollHandlerSet")&&(t.on("scroll",function(){clearTimeout(h),clearTimeout(b)}),t.prop("scrollHandlerSet","yes")),!0)}(g):E(g))?b=setTimeout(function(){T(g,e,t)},80):T(g,e,t):g=void 0}function O(){clearTimeout(b),M()}function D(){m?M():g&&!l?(clearTimeout(b),T(g,e,t),setTimeout(M,0)):M()}function I(e,t){y.emit({events:e,data:[t]})}function B(e){I("touchstart touchstart:active",e)}function R(e){I("touchmove touchmove:active",e)}function L(e){I("touchend touchend:active",e)}function A(e){I("touchstart:passive",e)}function z(e){I("touchmove:passive",e)}function H(e){I("touchend:passive",e)}Device.ios&&Device.webView&&win.addEventListener("touchstart",function(){});var U=!!Support.passiveListener&&{passive:!0},N=!!Support.passiveListener&&{passive:!1};doc.addEventListener("click",function(e){I("click",e)},!0),Support.passiveListener?(doc.addEventListener(y.touchEvents.start,B,N),doc.addEventListener(y.touchEvents.move,R,N),doc.addEventListener(y.touchEvents.end,L,N),doc.addEventListener(y.touchEvents.start,A,U),doc.addEventListener(y.touchEvents.move,z,U),doc.addEventListener(y.touchEvents.end,H,U)):(doc.addEventListener(y.touchEvents.start,function(e){B(e),A(e)},!1),doc.addEventListener(y.touchEvents.move,function(e){R(e),z(e)},!1),doc.addEventListener(y.touchEvents.end,function(e){L(e),H(e)},!1)),Support.touch?(w.fastClicks?(y.on("click",function(e){var t,a,i=!1;return n?(r=null,n=!1,!0):"submit"===e.target.type&&0===e.detail||"file"===e.target.type||(r||(t=e.target,a="input select textarea label".split(" "),t.nodeName&&a.indexOf(t.nodeName.toLowerCase())>=0||(i=!0)),f||(i=!0),doc.activeElement===r&&(i=!0),e.forwardedTouchEvent&&(i=!0),e.cancelable||(i=!0),w.tapHold&&w.tapHoldPreventClicks&&p&&(i=!1),i||(e.stopImmediatePropagation(),e.stopPropagation(),r?(function(e){var t=$(e),a=!0;return(t.is("label")||t.parents("label").length>0)&&(a=!Device.android&&!(!Device.ios||!t.is("input"))),a}(r)||l)&&e.preventDefault():e.preventDefault(),r=null),v=setTimeout(function(){f=!1},Device.ios||Device.androidChrome?100:400),w.tapHold&&(c=setTimeout(function(){p=!1},Device.ios||Device.androidChrome?100:400)),i)}),y.on("touchstart",function(d){var m,g,b=this;if(l=!1,p=!1,d.targetTouches.length>1)return u&&S(),!0;if(d.touches.length>1&&u&&S(),w.tapHold&&(c&&clearTimeout(c),c=setTimeout(function(){d&&d.touches&&d.touches.length>1||(p=!0,d.preventDefault(),$(d.target).trigger("taphold"))},w.tapHoldDelay)),v&&clearTimeout(v),m=d.target,g=$(m),!(f=!("input"===m.nodeName.toLowerCase()&&("file"===m.type||"range"===m.type)||"select"===m.nodeName.toLowerCase()&&Device.android||g.hasClass("no-fastclick")||g.parents(".no-fastclick").length>0||w.fastClicksExclude&&g.closest(w.fastClicksExclude).length>0)))return n=!1,!0;if(Device.ios||Device.android&&"getSelection"in win){var y=win.getSelection();if(y.rangeCount&&y.focusNode!==doc.body&&(!y.isCollapsed||doc.activeElement===y.focusNode))return i=!0,!0;i=!1}return Device.android&&function(e){var t="button input textarea select".split(" ");return!(!doc.activeElement||e===doc.activeElement||doc.activeElement===doc.body||t.indexOf(e.nodeName.toLowerCase())>=0)}(d.target)&&doc.activeElement.blur(),n=!0,r=d.target,a=(new Date).getTime(),e=d.targetTouches[0].pageX,t=d.targetTouches[0].pageY,Device.ios&&(s=void 0,$(r).parents().each(function(){var e=b;e.scrollHeight>e.offsetHeight&&!s&&((s=e).f7ScrollTop=s.scrollTop)})),a-o<w.fastClicksDelayBetweenClicks&&d.preventDefault(),w.activeState&&(u=x(r),h=setTimeout(k,0)),C&&P(r),!0}),y.on("touchmove",function(a){if(n){var i=w.fastClicksDistanceThreshold;if(i){var s=a.targetTouches[0].pageX,o=a.targetTouches[0].pageY;(Math.abs(s-e)>i||Math.abs(o-t)>i)&&(l=!0)}else l=!0;l&&(n=!1,r=null,l=!0,w.tapHold&&clearTimeout(c),w.activeState&&(clearTimeout(h),S()),C&&O())}}),y.on("touchend",function(e){clearTimeout(h),clearTimeout(c);var t=(new Date).getTime();if(!n)return!i&&f&&(Device.android&&!e.cancelable||!e.cancelable||e.preventDefault()),w.activeState&&S(),C&&D(),!0;if(doc.activeElement===e.target)return w.activeState&&S(),C&&D(),!0;if(i||e.preventDefault(),t-o<w.fastClicksDelayBetweenClicks)return setTimeout(S,0),C&&D(),!0;if(o=t,n=!1,Device.ios&&s&&s.scrollTop!==s.f7ScrollTop)return!1;if(w.activeState&&(k(),setTimeout(S,0)),C&&D(),function(e){if(doc.activeElement===e)return!1;var t=e.nodeName.toLowerCase(),a="button checkbox file image radio submit".split(" ");return!e.disabled&&!e.readOnly&&("textarea"===t||("select"===t?!Device.android:"input"===t&&a.indexOf(e.type)<0))}(r)){if(Device.ios&&Device.webView)return r.focus(),!1;r.focus()}return doc.activeElement&&r!==doc.activeElement&&doc.activeElement!==doc.body&&"label"!==r.nodeName.toLowerCase()&&doc.activeElement.blur(),e.preventDefault(),!(w.tapHoldPreventClicks&&p||(function(e){var t=e.changedTouches[0],a=doc.createEvent("MouseEvents"),n="click";Device.android&&"select"===r.nodeName.toLowerCase()&&(n="mousedown"),a.initMouseEvent(n,!0,!0,win,1,t.screenX,t.screenY,t.clientX,t.clientY,!1,!1,!1,!1,0,null),a.forwardedTouchEvent=!0,y.device.ios&&win.navigator.standalone?setTimeout(function(){(r=doc.elementFromPoint(e.changedTouches[0].clientX,e.changedTouches[0].clientY))&&r.dispatchEvent(a)},10):r.dispatchEvent(a)}(e),1))})):(y.on("click",function(e){var t=d;return r&&e.target!==r&&(t=!0),w.tapHold&&w.tapHoldPreventClicks&&p&&(t=!0),t&&(e.stopImmediatePropagation(),e.stopPropagation(),e.preventDefault()),w.tapHold&&(c=setTimeout(function(){p=!1},Device.ios||Device.androidChrome?100:400)),d=!1,r=null,!t}),y.on("touchstart",function(a){return l=!1,p=!1,d=!1,a.targetTouches.length>1?(u&&S(),!0):(a.touches.length>1&&u&&S(),w.tapHold&&(c&&clearTimeout(c),c=setTimeout(function(){a&&a.touches&&a.touches.length>1||(p=!0,a.preventDefault(),d=!0,$(a.target).trigger("taphold"))},w.tapHoldDelay)),r=a.target,e=a.targetTouches[0].pageX,t=a.targetTouches[0].pageY,w.activeState&&(E(u=x(r))?h=setTimeout(k,80):k()),C&&P(r),!0)}),y.on("touchmove",function(a){var r,n=0;if("touchmove"===a.type&&(r=a.targetTouches[0])&&"stylus"===r.touchType&&(n=5),n&&r){var i=r.pageX,s=r.pageY;(Math.abs(i-e)>n||Math.abs(s-t)>n)&&(l=!0)}else l=!0;l&&(d=!0,w.tapHold&&clearTimeout(c),w.activeState&&(clearTimeout(h),S()),C&&O())}),y.on("touchend",function(e){return clearTimeout(h),clearTimeout(c),doc.activeElement===e.target?(w.activeState&&S(),C&&D(),!0):(w.activeState&&(k(),setTimeout(S,0)),C&&D(),!(w.tapHoldPreventClicks&&p||d)||(e.cancelable&&e.preventDefault(),d=!0,!1))})),doc.addEventListener("touchcancel",function(){n=!1,r=null,clearTimeout(h),clearTimeout(c),w.activeState&&S(),C&&D()},{passive:!0})):w.activeState&&(y.on("touchstart",function(a){x(a.target).addClass("active-state"),"which"in a&&3===a.which&&setTimeout(function(){$(".active-state").removeClass("active-state")},0),C&&(e=a.pageX,t=a.pageY,P(a.target,a.pageX,a.pageY))}),y.on("touchmove",function(){$(".active-state").removeClass("active-state"),C&&O()}),y.on("touchend",function(){$(".active-state").removeClass("active-state"),C&&D()})),doc.addEventListener("contextmenu",function(e){w.disableContextMenu&&(Device.ios||Device.android||Device.cordova)&&e.preventDefault(),C&&(u&&S(),D())})}var TouchModule={name:"touch",params:{touch:{fastClicks:!1,fastClicksDistanceThreshold:10,fastClicksDelayBetweenClicks:50,fastClicksExclude:"",disableContextMenu:!1,tapHold:!1,tapHoldDelay:750,tapHoldPreventClicks:!0,activeState:!0,activeStateElements:"a, button, label, span, .actions-button, .stepper-button, .stepper-button-plus, .stepper-button-minus, .card-expandable, .menu-item",mdTouchRipple:!0,iosTouchRipple:!1,auroraTouchRipple:!1,touchRippleElements:".ripple, .link, .item-link, .list-button, .links-list a, .button, button, .input-clear-button, .dialog-button, .tab-link, .item-radio, .item-checkbox, .actions-button, .searchbar-disable-button, .fab a, .checkbox, .radio, .data-table .sortable-cell:not(.input-cell), .notification-close-button, .stepper-button, .stepper-button-minus, .stepper-button-plus, .menu-item-content"}},instance:{touchEvents:{start:Support.touch?"touchstart":"mousedown",move:Support.touch?"touchmove":"mousemove",end:Support.touch?"touchend":"mouseup"}},on:{init:initTouch}},pathToRegexp_1=pathToRegexp,parse_1=parse,compile_1=compile,tokensToFunction_1=tokensToFunction,tokensToRegExp_1=tokensToRegExp,DEFAULT_DELIMITER="/",PATH_REGEXP=new RegExp(["(\\\\.)","(?:\\:(\\w+)(?:\\(((?:\\\\.|[^\\\\()])+)\\))?|\\(((?:\\\\.|[^\\\\()])+)\\))([+*?])?"].join("|"),"g");function parse(e,t){for(var a,r=[],n=0,i=0,s="",o=t&&t.delimiter||DEFAULT_DELIMITER,l=t&&t.whitelist||void 0,p=!1;null!==(a=PATH_REGEXP.exec(e));){var c=a[0],d=a[1],u=a.index;if(s+=e.slice(i,u),i=u+c.length,d)s+=d[1],p=!0;else{var h="",f=a[2],v=a[3],m=a[4],g=a[5];if(!p&&s.length){var b=s.length-1,y=s[b];(!l||l.indexOf(y)>-1)&&(h=y,s=s.slice(0,b))}s&&(r.push(s),s="",p=!1);var w="+"===g||"*"===g,C="?"===g||"*"===g,x=v||m,$=h||o;r.push({name:f||n++,prefix:h,delimiter:$,optional:C,repeat:w,pattern:x?escapeGroup(x):"[^"+escapeString($===o?$:$+o)+"]+?"})}}return(s||i<e.length)&&r.push(s+e.substr(i)),r}function compile(e,t){return tokensToFunction(parse(e,t))}function tokensToFunction(e){for(var t=new Array(e.length),a=0;a<e.length;a++)"object"==typeof e[a]&&(t[a]=new RegExp("^(?:"+e[a].pattern+")$"));return function(a,r){for(var n="",i=r&&r.encode||encodeURIComponent,s=0;s<e.length;s++){var o=e[s];if("string"!=typeof o){var l,p=a?a[o.name]:void 0;if(Array.isArray(p)){if(!o.repeat)throw new TypeError('Expected "'+o.name+'" to not repeat, but got array');if(0===p.length){if(o.optional)continue;throw new TypeError('Expected "'+o.name+'" to not be empty')}for(var c=0;c<p.length;c++){if(l=i(p[c],o),!t[s].test(l))throw new TypeError('Expected all "'+o.name+'" to match "'+o.pattern+'"');n+=(0===c?o.prefix:o.delimiter)+l}}else if("string"!=typeof p&&"number"!=typeof p&&"boolean"!=typeof p){if(!o.optional)throw new TypeError('Expected "'+o.name+'" to be '+(o.repeat?"an array":"a string"))}else{if(l=i(String(p),o),!t[s].test(l))throw new TypeError('Expected "'+o.name+'" to match "'+o.pattern+'", but got "'+l+'"');n+=o.prefix+l}}else n+=o}return n}}function escapeString(e){return e.replace(/([.+*?=^!:${}()[\]|\/\\])/g,"\\$1")}function escapeGroup(e){return e.replace(/([=!:$\/()])/g,"\\$1")}function flags(e){return e&&e.sensitive?"":"i"}function regexpToRegexp(e,t){if(!t)return e;var a=e.source.match(/\((?!\?)/g);if(a)for(var r=0;r<a.length;r++)t.push({name:r,prefix:null,delimiter:null,optional:!1,repeat:!1,pattern:null});return e}function arrayToRegexp(e,t,a){for(var r=[],n=0;n<e.length;n++)r.push(pathToRegexp(e[n],t,a).source);return new RegExp("(?:"+r.join("|")+")",flags(a))}function stringToRegexp(e,t,a){return tokensToRegExp(parse(e,a),t,a)}function tokensToRegExp(e,t,a){for(var r=(a=a||{}).strict,n=!1!==a.start,i=!1!==a.end,s=a.delimiter||DEFAULT_DELIMITER,o=[].concat(a.endsWith||[]).map(escapeString).concat("$").join("|"),l=n?"^":"",p=0;p<e.length;p++){var c=e[p];if("string"==typeof c)l+=escapeString(c);else{var d=c.repeat?"(?:"+c.pattern+")(?:"+escapeString(c.delimiter)+"(?:"+c.pattern+"))*":c.pattern;t&&t.push(c),c.optional?c.prefix?l+="(?:"+escapeString(c.prefix)+"("+d+"))?":l+="("+d+")?":l+=escapeString(c.prefix)+"("+d+")"}}if(i)r||(l+="(?:"+escapeString(s)+")?"),l+="$"===o?"$":"(?="+o+")";else{var u=e[e.length-1],h="string"==typeof u?u[u.length-1]===s:void 0===u;r||(l+="(?:"+escapeString(s)+"(?="+o+"))?"),h||(l+="(?="+escapeString(s)+"|"+o+")")}return new RegExp(l,flags(a))}function pathToRegexp(e,t,a){return e instanceof RegExp?regexpToRegexp(e,t):Array.isArray(e)?arrayToRegexp(e,t,a):stringToRegexp(e,t,a)}pathToRegexp_1.parse=parse_1,pathToRegexp_1.compile=compile_1,pathToRegexp_1.tokensToFunction=tokensToFunction_1,pathToRegexp_1.tokensToRegExp=tokensToRegExp_1;var History={queue:[],clearQueue:function(){0!==History.queue.length&&History.queue.shift()()},routerQueue:[],clearRouterQueue:function(){if(0!==History.routerQueue.length){var e=History.routerQueue.pop(),t=e.router,a=e.stateUrl,r=e.action,n=t.params.animate;!1===t.params.pushStateAnimate&&(n=!1),"back"===r&&t.back({animate:n,pushState:!1}),"load"===r&&t.navigate(a,{animate:n,pushState:!1})}},handle:function(e){if(!History.blockPopstate){var t=e.state;History.previousState=History.state,History.state=t,History.allowChange=!0,History.clearQueue(),(t=History.state)||(t={}),this.views.forEach(function(e){var a=e.router,r=t[e.id];if(!r&&e.params.pushState&&(r={url:e.router.history[0]}),r){var n=r.url||void 0,i=a.params.animate;!1===a.params.pushStateAnimate&&(i=!1),n!==a.url&&(a.history.indexOf(n)>=0?a.allowPageChange?a.back({animate:i,pushState:!1}):History.routerQueue.push({action:"back",router:a}):a.allowPageChange?a.navigate(n,{animate:i,pushState:!1}):History.routerQueue.unshift({action:"load",stateUrl:n,router:a}))}})}},initViewState:function(e,t){var a,r=Utils.extend({},History.state||{},((a={})[e]=t,a));History.state=r,win.history.replaceState(r,"")},push:function(e,t,a){var r;if(History.allowChange){History.previousState=History.state;var n=Utils.extend({},History.previousState||{},((r={})[e]=t,r));History.state=n,win.history.pushState(n,"",a)}else History.queue.push(function(){History.push(e,t,a)})},replace:function(e,t,a){var r;if(History.allowChange){History.previousState=History.state;var n=Utils.extend({},History.previousState||{},((r={})[e]=t,r));History.state=n,win.history.replaceState(n,"",a)}else History.queue.push(function(){History.replace(e,t,a)})},go:function(e){History.allowChange=!1,win.history.go(e)},back:function(){History.allowChange=!1,win.history.back()},allowChange:!0,previousState:{},state:win.history.state,blockPopstate:!0,init:function(e){$(win).on("load",function(){setTimeout(function(){History.blockPopstate=!1},0)}),doc.readyState&&"complete"===doc.readyState&&(History.blockPopstate=!1),$(win).on("popstate",History.handle.bind(e))}};function SwipeBack(e){var t,a,r,n,i,s,o,l,p,c,d=e,u=d.$el,h=d.$navbarEl,f=d.app,v=d.params,m=!1,g=!1,b={},y=[],w=[],C=!0,x=[],E=[],k=v[f.theme+"SwipeBackAnimateShadow"],S=v[f.theme+"SwipeBackAnimateOpacity"],T=v[f.theme+"SwipeBackActiveArea"],M=v[f.theme+"SwipeBackThreshold"],P=f.rtl?"right center":"left center";function O(e){void 0===e&&(e={});for(var t=e.progress,a=e.reset,r=e.transition,n=["overflow","transform","transform-origin","opacity"],i=0;i<p.length;i+=1){var s=p[i];if(s&&s.el){!0===r&&s.el.classList.add("navbar-page-transitioning"),!1===r&&s.el.classList.remove("navbar-page-transitioning");for(var o=0;o<n.length;o+=1){var l=n[o];s[l]&&(a?s.el.style[l]="":"function"==typeof s[l]?s.el.style[l]=s[l](t):s.el.style[l]=s[l])}}}}function D(e){var a=v[f.theme+"SwipeBack"];!C||!a||m||f.swipeout&&f.swipeout.el||!d.allowPageChange||$(e.target).closest(".range-slider, .calendar-months").length>0||$(e.target).closest(".page-master, .page-master-detail").length>0&&v.masterDetailBreakpoint>0&&f.width>=v.masterDetailBreakpoint||(g=!1,m=!0,t=void 0,b.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,b.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,n=Utils.now(),i=d.dynamicNavbar,s=d.separateNavbar)}function I(e){if(m){var n="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,c="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;if(void 0===t&&(t=!!(t||Math.abs(c-b.y)>Math.abs(n-b.x))||n<b.x&&!f.rtl||n>b.x&&f.rtl),t||e.f7PreventSwipeBack||f.preventSwipeBack)m=!1;else{if(!g){var C=!1,D=$(e.target),I=D.closest(".swipeout");I.length>0&&(!f.rtl&&I.find(".swipeout-actions-left").length>0&&(C=!0),f.rtl&&I.find(".swipeout-actions-right").length>0&&(C=!0)),((y=D.closest(".page")).hasClass("no-swipeback")||D.closest(".no-swipeback, .card-opened").length>0)&&(C=!0),w=u.find(".page-previous:not(.stacked)");b.x,u.offset().left;if(a=u.width(),(f.rtl?b.x<u.offset().left-u[0].scrollLeft+(a-T):b.x-u.offset().left>T)&&(C=!0),0!==w.length&&0!==y.length||(C=!0),C)return void(m=!1);k&&0===(o=y.find(".page-shadow-effect")).length&&(o=$('<div class="page-shadow-effect"></div>'),y.append(o)),S&&0===(l=w.find(".page-opacity-effect")).length&&(l=$('<div class="page-opacity-effect"></div>'),w.append(l)),i&&(s?(x=h.find(".navbar-current:not(.stacked)"),E=h.find(".navbar-previous:not(.stacked)")):(x=y.children(".navbar").children(".navbar-inner"),E=w.children(".navbar").children(".navbar-inner")),p=function(){var e,t,a=[],r=f.rtl?-1:1,n=x.hasClass("navbar-inner-large"),i=E.hasClass("navbar-inner-large"),o=n&&!x.hasClass("navbar-inner-large-collapsed"),l=i&&!E.hasClass("navbar-inner-large-collapsed"),p=x.children(".left, .title, .right, .subnavbar, .fading, .title-large"),c=E.children(".left, .title, .right, .subnavbar, .fading, .title-large");return v.iosAnimateNavbarBackIcon&&(e=x.hasClass("sliding")?x.children(".left").find(".back .icon + span").eq(0):x.children(".left.sliding").find(".back .icon + span").eq(0),t=E.hasClass("sliding")?E.children(".left").find(".back .icon + span").eq(0):E.children(".left.sliding").find(".back .icon + span").eq(0),e.length&&c.each(function(t,a){$(a).hasClass("title")&&(a.f7NavbarLeftOffset+=e.prev(".icon")[0].offsetWidth)})),p.each(function(t,i){var p=$(i),c=p.hasClass("subnavbar"),d=p.hasClass("left"),u=p.hasClass("title");if(o||!p.hasClass(".title-large")){var h={el:i};if(o){if(u)return;if(p.hasClass("title-large")){if(!s)return;return void(l?(a.indexOf(h)<0&&a.push(h),h.overflow="visible",h.transform="translateX(100%)",p.find(".title-large-text, .title-large-inner").each(function(e,t){a.push({el:t,transform:function(e){return"translateX("+(100*e*r-100)+"%)"}})})):(a.indexOf(h)<0&&a.push(h),h.overflow="hidden",h.transform=function(e){return"translateY(calc("+-e+" * var(--f7-navbar-large-title-height)))"},p.find(".title-large-text, .title-large-inner").each(function(e,t){a.push({el:t,transform:function(e){return"translateX("+100*e*r+"%) translateY(calc("+e+" * var(--f7-navbar-large-title-height)))"}})})))}}if(l){if(!o&&p.hasClass("title-large")){if(!s)return;a.indexOf(h)<0&&a.push(h),h.opacity=0}if(d&&s)return a.indexOf(h)<0&&a.push(h),h.opacity=function(e){return 1-Math.pow(e,.33)},void p.find(".back span").each(function(e,t){a.push({el:t,"transform-origin":P,transform:function(e){return"translateY(calc(var(--f7-navbar-height) * "+e+")) scale("+(1+1*e)+")"}})})}if(!p.hasClass("title-large")){var f=p.hasClass("sliding")||x.hasClass("sliding");if(a.indexOf(h)<0&&a.push(h),(!c||c&&!f)&&(h.opacity=function(e){return 1-Math.pow(e,.33)}),f){var m=h;if(d&&e.length&&v.iosAnimateNavbarBackIcon){var g={el:e[0]};m=g,a.push(g)}m.transform=function(e){var t=e*m.el.f7NavbarRightOffset;return 1===Device.pixelRatio&&(t=Math.round(t)),c&&n&&s?"translate3d("+t+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)":"translate3d("+t+"px,0,0)"}}}}}),c.each(function(e,n){var p=$(n),c=p.hasClass("subnavbar"),d=p.hasClass("left"),u=p.hasClass("title"),h={el:n};if(l){if(u)return;if(a.indexOf(h)<0&&a.push(h),p.hasClass("title-large")){if(!s)return;return o?(h.opacity=1,h.overflow="visible",h.transform="translateY(0)",p.find(".title-large-text").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"translateY(calc("+(1*e-1)+" * var(--f7-navbar-large-title-height))) scale("+(.5+.5*e)+")"}})})):(h.transform=function(e){return"translateY(calc("+(e-1)+" * var(--f7-navbar-large-title-height)))"},h.opacity=1,h.overflow="hidden",p.find(".title-large-text").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"scale("+(.5+.5*e)+")"}})})),void p.find(".title-large-inner").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"translateX("+-100*(1-e)*r+"%)"}})})}}if(!p.hasClass("title-large")){var f=p.hasClass("sliding")||E.hasClass("sliding");if(a.indexOf(h)<0&&a.push(h),(!c||c&&!f)&&(h.opacity=function(e){return Math.pow(e,3)}),f){var m=h;if(d&&t.length&&v.iosAnimateNavbarBackIcon){var g={el:t[0]};m=g,a.push(g)}m.transform=function(e){var t=m.el.f7NavbarLeftOffset*(1-e);return 1===Device.pixelRatio&&(t=Math.round(t)),c&&i&&s?"translate3d("+t+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)":"translate3d("+t+"px,0,0)"}}}}),a}()),$(".sheet.modal-in").length>0&&f.sheet&&f.sheet.close($(".sheet.modal-in"))}e.f7PreventPanelSwipe=!0,g=!0,f.preventSwipePanelBySwipeBack=!0,e.preventDefault();var B=f.rtl?-1:1;(r=(n-b.x-M)*B)<0&&(r=0);var R=Math.min(Math.max(r/a,0),1),L={percentage:R,progress:R,currentPageEl:y[0],previousPageEl:w[0],currentNavbarEl:x[0],previousNavbarEl:E[0]};u.trigger("swipeback:move",L),d.emit("swipebackMove",L);var A=r*B,z=(r/5-a/5)*B;f.rtl?(A=Math.max(A,-a),z=Math.max(z,0)):(A=Math.min(A,a),z=Math.min(z,0)),1===Device.pixelRatio&&(A=Math.round(A),z=Math.round(z)),d.swipeBackActive=!0,$([y[0],w[0]]).addClass("page-swipeback-active"),y.transform("translate3d("+A+"px,0,0)"),k&&(o[0].style.opacity=1-1*R),"ios"===f.theme&&w.transform("translate3d("+z+"px,0,0)"),S&&(l[0].style.opacity=1-1*R),i&&O({progress:R})}}}function B(){if(f.preventSwipePanelBySwipeBack=!1,!m||!g)return m=!1,void(g=!1);if(m=!1,g=!1,d.swipeBackActive=!1,$([y[0],w[0]]).removeClass("page-swipeback-active"),0===r)return $([y[0],w[0]]).transform(""),o&&o.length>0&&o.remove(),l&&l.length>0&&l.remove(),void(i&&O({reset:!0}));var e=Utils.now()-n,t=!1;(e<300&&r>10||e>=300&&r>a/2)&&(y.removeClass("page-current").addClass("page-next"+("ios"!==f.theme?" page-next-on-right":"")),w.removeClass("page-previous").addClass("page-current").removeAttr("aria-hidden"),o&&(o[0].style.opacity=""),l&&(l[0].style.opacity=""),i&&(x.removeClass("navbar-current").addClass("navbar-next"),E.removeClass("navbar-previous").addClass("navbar-current").removeAttr("aria-hidden")),t=!0),$([y[0],w[0]]).addClass("page-transitioning page-transitioning-swipeback").transform(""),i&&O({progress:t?1:0,transition:!0}),C=!1,d.allowPageChange=!1;var p={currentPageEl:y[0],previousPageEl:w[0],currentNavbarEl:x[0],previousNavbarEl:E[0]};t?(d.currentRoute=w[0].f7Page.route,d.currentPage=w[0],d.pageCallback("beforeOut",y,x,"current","next",{route:y[0].f7Page.route,swipeBack:!0}),d.pageCallback("beforeIn",w,E,"previous","current",{route:w[0].f7Page.route,swipeBack:!0}),u.trigger("swipeback:beforechange",p),d.emit("swipebackBeforeChange",p)):(u.trigger("swipeback:beforereset",p),d.emit("swipebackBeforeReset",p)),y.transitionEnd(function(){$([y[0],w[0]]).removeClass("page-transitioning page-transitioning-swipeback"),i&&O({reset:!0,transition:!1}),C=!0,d.allowPageChange=!0,t?(1===d.history.length&&d.history.unshift(d.url),d.history.pop(),d.saveHistory(),v.pushState&&History.back(),d.pageCallback("afterOut",y,x,"current","next",{route:y[0].f7Page.route,swipeBack:!0}),d.pageCallback("afterIn",w,E,"previous","current",{route:w[0].f7Page.route,swipeBack:!0}),v.stackPages&&d.initialPages.indexOf(y[0])>=0?(y.addClass("stacked"),s&&x.addClass("stacked")):(d.pageCallback("beforeRemove",y,x,"next",{swipeBack:!0}),d.removePage(y),s&&d.removeNavbar(x)),u.trigger("swipeback:afterchange",p),d.emit("swipebackAfterChange",p),d.emit("routeChanged",d.currentRoute,d.previousRoute,d),v.preloadPreviousPage&&d.back(d.history[d.history.length-2],{preload:!0})):(u.trigger("swipeback:afterreset",p),d.emit("swipebackAfterReset",p)),o&&o.length>0&&o.remove(),l&&l.length>0&&l.remove()})}c=!("touchstart"!==f.touchEvents.start||!Support.passiveListener)&&{passive:!0,capture:!1},u.on(f.touchEvents.start,D,c),f.on("touchmove:active",I),f.on("touchend:passive",B),d.on("routerDestroy",function(){var e=!("touchstart"!==f.touchEvents.start||!Support.passiveListener)&&{passive:!0,capture:!1};u.off(f.touchEvents.start,D,e),f.off("touchmove:active",I),f.off("touchend:passive",B)})}function redirect(e,t,a){var r=this,n=t.route.redirect;if(a.initial&&r.params.pushState&&(a.replaceState=!0,a.history=!0),"function"==typeof n){r.allowPageChange=!1;var i=n.call(r,t,function(t,n){void 0===n&&(n={}),r.allowPageChange=!0,r[e](t,Utils.extend({},a,n))},function(){r.allowPageChange=!0});return i&&"string"==typeof i?(r.allowPageChange=!0,r[e](i,a)):r}return r[e](n,a)}function processQueue(e,t,a,r,n,i,s){var o=[];Array.isArray(a)?o.push.apply(o,a):a&&"function"==typeof a&&o.push(a),t&&(Array.isArray(t)?o.push.apply(o,t):o.push(t)),function t(){0!==o.length?o.shift().call(e,r,n,function(){t()},function(){s()}):i()}()}function processRouteQueue(e,t,a,r){var n=this;function i(){e&&e.route&&(n.params.routesBeforeEnter||e.route.beforeEnter)?(n.allowPageChange=!1,processQueue(n,n.params.routesBeforeEnter,e.route.beforeEnter,e,t,function(){n.allowPageChange=!0,a()},function(){r()})):a()}t&&t.route&&(n.params.routesBeforeLeave||t.route.beforeLeave)?(n.allowPageChange=!1,processQueue(n,n.params.routesBeforeLeave,t.route.beforeLeave,e,t,function(){n.allowPageChange=!0,i()},function(){r()})):i()}function appRouterCheck(e,t){if(!e.view)throw new Error("Framework7: it is not allowed to use router methods on global app router. Use router methods only on related View, e.g. app.views.main.router."+t+"(...)")}function refreshPage(){return appRouterCheck(this,"refreshPage"),this.navigate(this.currentRoute.url,{ignoreCache:!0,reloadCurrent:!0})}function forward(e,t){void 0===t&&(t={});var a,r,n,i=this,s=$(e),o=i.app,l=i.view,p=Utils.extend(!1,{animate:i.params.animate,pushState:!0,replaceState:!1,history:!0,reloadCurrent:i.params.reloadPages,reloadPrevious:!1,reloadAll:!1,clearPreviousHistory:!1,reloadDetail:i.params.reloadDetail,on:{}},t),c=i.params.masterDetailBreakpoint>0,d=c&&p.route&&p.route.route&&!0===p.route.route.master,u=i.currentRoute.modal;if(u||"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(e){i.currentRoute&&i.currentRoute.route&&i.currentRoute.route[e]&&(u=!0,n=e)}),u){var h=i.currentRoute.modal||i.currentRoute.route.modalInstance||o[n].get(),f=i.history[i.history.length-2],v=i.findMatchingRoute(f);!v&&f&&(v={url:f,path:f.split("?")[0],query:Utils.parseUrlQuery(f),route:{path:f.split("?")[0],url:f}}),i.modalRemove(h)}var m,g,b,y,w=i.dynamicNavbar,C=i.separateNavbar,x=i.$el,E=s,k=p.reloadPrevious||p.reloadCurrent||p.reloadAll;if(i.allowPageChange=!1,0===E.length)return i.allowPageChange=!0,i;E.length&&i.removeThemeElements(E),w&&(b=E.children(".navbar").children(".navbar-inner"),C&&(g=i.$navbarEl,b.length>0&&E.children(".navbar").remove(),0===b.length&&E[0]&&E[0].f7Page&&(b=E[0].f7Page.$navbarEl))),p.route&&p.route.route&&p.route.route.keepAlive&&!p.route.route.keepAliveData&&(p.route.route.keepAliveData={pageEl:s[0]});var S,T,M,P=x.children(".page:not(.stacked)").filter(function(e,t){return t!==E[0]});if(C&&(S=g.children(".navbar-inner:not(.stacked)").filter(function(e,t){return t!==b[0]})),p.reloadPrevious&&P.length<2)return i.allowPageChange=!0,i;if(c&&!p.reloadAll){for(var O=0;O<P.length;O+=1)a||!P[O].classList.contains("page-master")||(a=P[O]);if((T=!d&&a)&&a)for(var D=0;D<P.length;D+=1)P[D].classList.contains("page-master-detail")&&(r=P[D]);M=T&&p.reloadDetail&&o.width>=i.params.masterDetailBreakpoint&&a}var I="next";if(p.reloadCurrent||p.reloadAll||M?I="current":p.reloadPrevious&&(I="previous"),E.addClass("page-"+I+(d?" page-master":"")+(T?" page-master-detail":"")).removeClass("stacked").trigger("page:unstack").trigger("page:position",{position:I}),(d||T)&&E.trigger("page:role",{role:d?"master":"detail"}),w&&b.length&&b.addClass("navbar-"+I+(d?" navbar-master":"")+(T?" navbar-master-detail":"")).removeClass("stacked"),p.reloadCurrent||M)m=P.eq(P.length-1),C&&(y=$(o.navbar.getElByPage(m)));else if(p.reloadPrevious)m=P.eq(P.length-2),C&&(y=$(o.navbar.getElByPage(m)));else if(p.reloadAll)m=P.filter(function(e,t){return t!==E[0]}),C&&(y=S.filter(function(e,t){return t!==b[0]}));else{if(P.length>1){var B=0;for(B=0;B<P.length-1;B+=1)if(a&&P[B]===a)P.eq(B).addClass("page-master-stacked"),P.eq(B).trigger("page:masterstack"),C&&$(o.navbar.getElByPage(a)).addClass("navbar-master-stacked");else{var R=o.navbar.getElByPage(P.eq(B));i.params.stackPages?(P.eq(B).addClass("stacked"),P.eq(B).trigger("page:stack"),C&&$(R).addClass("stacked")):(i.pageCallback("beforeRemove",P[B],S&&S[B],"previous",void 0,p),i.removePage(P[B]),C&&R&&i.removeNavbar(R))}}m=x.children(".page:not(.stacked)").filter(function(e,t){return t!==E[0]}),C&&(y=g.children(".navbar-inner:not(.stacked)").filter(function(e,t){return t!==b[0]}))}if(w&&!C&&(y=m.children(".navbar").children(".navbar-inner")),T&&!p.reloadAll&&((m.length>1||M)&&(m=m.filter(function(e,t){return!t.classList.contains("page-master")})),y&&(y.length>1||M)&&(y=y.filter(function(e,t){return!t.classList.contains("navbar-master")}))),i.params.pushState&&(p.pushState||p.replaceState)&&!p.reloadPrevious){var L=i.params.pushStateRoot||"";History[p.reloadCurrent||M&&r||p.reloadAll||p.replaceState?"replace":"push"](l.id,{url:p.route.url},L+i.params.pushStateSeparator+p.route.url)}p.reloadPrevious||(i.currentPageEl=E[0],w&&b.length?i.currentNavbarEl=b[0]:delete i.currentNavbarEl,i.currentRoute=p.route);var A=p.route.url;p.history&&(((p.reloadCurrent||M&&r)&&i.history.length)>0||p.replaceState?i.history[i.history.length-(p.reloadPrevious?2:1)]=A:p.reloadPrevious?i.history[i.history.length-2]=A:p.reloadAll?i.history=[A]:i.history.push(A)),i.saveHistory();var z=E.parents(doc).length>0,H=E[0].f7Component;if(p.reloadPrevious?(H&&!z?H.$mount(function(e){$(e).insertBefore(m)}):E.insertBefore(m),C&&b.length&&(b.children(".title-large").length&&b.addClass("navbar-inner-large"),y.length?b.insertBefore(y):(i.$navbarEl.parents(doc).length||i.$el.prepend(i.$navbarEl),g.append(b)))):(m.next(".page")[0]!==E[0]&&(H&&!z?H.$mount(function(e){x.append(e)}):x.append(E[0])),C&&b.length&&(b.children(".title-large").length&&b.addClass("navbar-inner-large"),i.$navbarEl.parents(doc).length||i.$el.prepend(i.$navbarEl),g.append(b[0]))),z?p.route&&p.route.route&&p.route.route.keepAlive&&!E[0].f7PageMounted&&(E[0].f7PageMounted=!0,i.pageCallback("mounted",E,b,I,k?I:"current",p,m)):i.pageCallback("mounted",E,b,I,k?I:"current",p,m),(p.reloadCurrent||M)&&m.length>0?i.params.stackPages&&i.initialPages.indexOf(m[0])>=0?(m.addClass("stacked"),m.trigger("page:stack"),C&&y.addClass("stacked")):(i.pageCallback("beforeRemove",m,y,"previous",void 0,p),i.removePage(m),C&&y&&y.length&&i.removeNavbar(y)):p.reloadAll?m.each(function(e,t){var a=$(t),r=$(o.navbar.getElByPage(a));i.params.stackPages&&i.initialPages.indexOf(a[0])>=0?(a.addClass("stacked"),a.trigger("page:stack"),C&&r.addClass("stacked")):(i.pageCallback("beforeRemove",a,y&&y.eq(e),"previous",void 0,p),i.removePage(a),C&&r.length&&i.removeNavbar(r))}):p.reloadPrevious&&(i.params.stackPages&&i.initialPages.indexOf(m[0])>=0?(m.addClass("stacked"),m.trigger("page:stack"),C&&y.addClass("stacked")):(i.pageCallback("beforeRemove",m,y,"previous",void 0,p),i.removePage(m),C&&y&&y.length&&i.removeNavbar(y))),p.route.route.tab&&i.tabLoad(p.route.route.tab,Utils.extend({},p,{history:!1,pushState:!1})),i.pageCallback("init",E,b,I,k?I:"current",p,m),p.reloadCurrent||p.reloadAll||M)return i.allowPageChange=!0,i.pageCallback("beforeIn",E,b,I,"current",p),i.pageCallback("afterIn",E,b,I,"current",p),p.reloadCurrent&&p.clearPreviousHistory&&i.clearPreviousHistory(),M&&(a.classList.add("page-previous"),a.classList.remove("page-current"),$(a).trigger("page:position",{position:"previous"}),a.f7Page&&a.f7Page.navbarEl&&(a.f7Page.navbarEl.classList.add("navbar-previous"),a.f7Page.navbarEl.classList.remove("navbar-current"))),i;if(p.reloadPrevious)return i.allowPageChange=!0,i;function U(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";E.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),m.removeClass(e).addClass("page-previous").trigger("page:position",{position:"previous"}),m.hasClass("page-master")||m.attr("aria-hidden","true"),w&&(b.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),y.removeClass(t).addClass("navbar-previous"),y.hasClass("navbar-master")||y.attr("aria-hidden","true")),i.allowPageChange=!0,i.pageCallback("afterIn",E,b,"next","current",p),i.pageCallback("afterOut",m,y,"current","previous",p);var a=(i.params.preloadPreviousPage||i.params[o.theme+"SwipeBack"])&&!d;a||(E.hasClass("smart-select-page")||E.hasClass("photo-browser-page")||E.hasClass("autocomplete-page"))&&(a=!0),a||(i.params.stackPages?(m.addClass("stacked"),m.trigger("page:stack"),C&&y.addClass("stacked")):E.attr("data-name")&&"smart-select-page"===E.attr("data-name")||(i.pageCallback("beforeRemove",m,y,"previous",void 0,p),i.removePage(m),C&&y.length&&i.removeNavbar(y))),p.clearPreviousHistory&&i.clearPreviousHistory(),i.emit("routeChanged",i.currentRoute,i.previousRoute,i),i.params.pushState&&History.clearRouterQueue()}function N(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";m.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),E.removeClass(e).addClass("page-next").removeAttr("aria-hidden").trigger("page:position",{position:"next"}),w&&(y.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),b.removeClass(t).addClass("navbar-next").removeAttr("aria-hidden"))}if(i.pageCallback("beforeIn",E,b,"next","current",p),i.pageCallback("beforeOut",m,y,"current","previous",p),!p.animate||d&&o.width>=i.params.masterDetailBreakpoint)U();else{var F=i.params[i.app.theme+"PageLoadDelay"];F?setTimeout(function(){N(),i.animate(m,E,y,b,"forward",function(){U()})},F):(N(),i.animate(m,E,y,b,"forward",function(){U()}))}return i}function load(e,t,a){void 0===e&&(e={}),void 0===t&&(t={});var r=this;if(!r.allowPageChange&&!a)return r;var n=e,i=t,s=n.url,o=n.content,l=n.el,p=n.pageName,c=n.template,d=n.templateUrl,u=n.component,h=n.componentUrl;if(!i.reloadCurrent&&i.route&&i.route.route&&i.route.route.parentPath&&r.currentRoute.route&&r.currentRoute.route.parentPath===i.route.route.parentPath){if(i.route.url===r.url)return r.allowPageChange=!0,!1;var f=Object.keys(i.route.params).length===Object.keys(r.currentRoute.params).length;if(f&&Object.keys(i.route.params).forEach(function(e){e in r.currentRoute.params&&r.currentRoute.params[e]===i.route.params[e]||(f=!1)}),f)return!!i.route.route.tab&&r.tabLoad(i.route.route.tab,i);if(!f&&i.route.route.tab&&r.currentRoute.route.tab&&r.currentRoute.parentPath===i.route.parentPath)return r.tabLoad(i.route.route.tab,i)}if(i.route&&i.route.url&&r.url===i.route.url&&!i.reloadCurrent&&!i.reloadPrevious&&!r.params.allowDuplicateUrls)return r.allowPageChange=!0,!1;function v(e,t){return r.forward(e,Utils.extend(i,t))}function m(){return r.allowPageChange=!0,r}if(!i.route&&s&&(i.route=r.parseRouteUrl(s),Utils.extend(i.route,{route:{url:s,path:s}})),(s||d||h)&&(r.allowPageChange=!1),o)r.forward(r.getPageEl(o),i);else if(c||d)try{r.pageTemplateLoader(c,d,i,v,m)}catch(e){throw r.allowPageChange=!0,e}else if(l)r.forward(r.getPageEl(l),i);else if(p)r.forward(r.$el.children('.page[data-name="'+p+'"]').eq(0),i);else if(u||h)try{r.pageComponentLoader(r.el,u,h,i,v,m)}catch(e){throw r.allowPageChange=!0,e}else s&&(r.xhr&&(r.xhr.abort(),r.xhr=!1),r.xhrRequest(s,i).then(function(e){r.forward(r.getPageEl(e),i)}).catch(function(){r.allowPageChange=!0}));return r}function navigate(e,t){void 0===t&&(t={});var a,r,n,i,s,o,l=this;if(l.swipeBackActive)return l;if("string"==typeof e?a=e:(a=e.url,r=e.route,n=e.name,i=e.query,s=e.params),n){if(!(o=l.findRouteByKey("name",n)))throw new Error('Framework7: route with name "'+n+'" not found');if(a=l.constructRouteUrl(o,{params:s,query:i}))return l.navigate(a,t);throw new Error("Framework7: can't construct URL for route with name \""+n+'"')}var p=l.app;if(appRouterCheck(l,"navigate"),"#"===a||""===a)return l;var c=a.replace("./","");if("/"!==c[0]&&0!==c.indexOf("#")){var d=l.currentRoute.parentPath||l.currentRoute.path;c=((d?d+"/":"/")+c).replace("///","/").replace("//","/")}if(!(o=r?Utils.extend(l.parseRouteUrl(c),{route:Utils.extend({},r)}):l.findMatchingRoute(c)))return l;if(o.route.redirect)return redirect.call(l,"navigate",o,t);var u={};function h(){var e=!1;"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(t){o.route[t]&&!e&&(e=!0,l.modalLoad(t,o,u))}),o.route.keepAlive&&o.route.keepAliveData&&(l.load({el:o.route.keepAliveData.pageEl},u,!1),e=!0),"url content component pageName el componentUrl template templateUrl".split(" ").forEach(function(t){var a;o.route[t]&&!e&&(e=!0,l.load(((a={})[t]=o.route[t],a),u,!1))}),e||o.route.async&&(l.allowPageChange=!1,o.route.async.call(l,u.route,l.currentRoute,function(e,t){l.allowPageChange=!1;var a=!1;t&&t.context&&(o.context?o.context=Utils.extend({},o.context,t.context):o.context=t.context,u.route.context=o.context),"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(r){if(e[r]){a=!0;var n=Utils.extend({},o,{route:e});l.allowPageChange=!0,l.modalLoad(r,n,Utils.extend(u,t))}}),a||l.load(e,Utils.extend(u,t),!0)},function(){l.allowPageChange=!0}))}function f(){l.allowPageChange=!0}if(o.route.options?Utils.extend(u,o.route.options,t):Utils.extend(u,t),u.route=o,u&&u.context&&(o.context=u.context,u.route.context=u.context),l.params.masterDetailBreakpoint>0&&o.route.masterRoute){var v=!0;if(l.currentRoute&&l.currentRoute.route&&(!l.currentRoute.route.master||l.currentRoute.route!==o.route.masterRoute&&l.currentRoute.route.path!==o.route.masterRoute.path||(v=!1),!l.currentRoute.route.masterRoute||l.currentRoute.route.masterRoute!==o.route.masterRoute&&l.currentRoute.route.masterRoute.path!==o.route.masterRoute.path||(v=!1)),v)return l.navigate(o.route.masterRoute.path,{animate:!1,reloadAll:t.reloadAll,reloadCurrent:t.reloadCurrent,reloadPrevious:t.reloadPrevious,once:{pageAfterIn:function(){l.navigate(e,Utils.extend({},t,{animate:!1,reloadAll:!1,reloadCurrent:!1,reloadPrevious:!1}))}}}),l}return processRouteQueue.call(l,o,l.currentRoute,function(){o.route.modules?p.loadModules(Array.isArray(o.route.modules)?o.route.modules:[o.route.modules]).then(function(){h()}).catch(function(){f()}):h()},function(){f()}),l}function tabLoad(e,t){void 0===t&&(t={});var a,r,n=this,i=Utils.extend({animate:n.params.animate,pushState:!0,history:!0,parentPageEl:null,preload:!1,on:{}},t);i.route&&(i.preload||i.route===n.currentRoute||(r=n.previousRoute,n.currentRoute=i.route),i.preload?(a=i.route,r=n.currentRoute):(a=n.currentRoute,r||(r=n.previousRoute)),n.params.pushState&&i.pushState&&!i.reloadPrevious&&History.replace(n.view.id,{url:i.route.url},(n.params.pushStateRoot||"")+n.params.pushStateSeparator+i.route.url),i.history&&(n.history[Math.max(n.history.length-1,0)]=i.route.url,n.saveHistory()));var s,o=$(i.parentPageEl||n.currentPageEl);s=o.length&&o.find("#"+e.id).length?o.find("#"+e.id).eq(0):n.view.selector?n.view.selector+" #"+e.id:"#"+e.id;var l,p=n.app.tab.show({tabEl:s,animate:i.animate,tabRoute:i.route}),c=p.$newTabEl,d=p.$oldTabEl,u=p.animated,h=p.onTabsChanged;if(c&&c.parents(".page").length>0&&i.route){var f=c.parents(".page")[0].f7Page;f&&i.route&&(f.route=i.route)}if(c[0].f7RouterTabLoaded)return d&&d.length?(u?h(function(){n.emit("routeChanged",n.currentRoute,n.previousRoute,n)}):n.emit("routeChanged",n.currentRoute,n.previousRoute,n),n):n;function v(t,a){var r=t.url,i=t.content,s=t.el,o=t.template,l=t.templateUrl,p=t.component,f=t.componentUrl;function v(t){n.allowPageChange=!0,t&&("string"==typeof t?c.html(t):(c.html(""),t.f7Component?t.f7Component.$mount(function(e){c.append(e)}):c.append(t)),c[0].f7RouterTabLoaded=!0,function(t){n.removeThemeElements(c);var a=c;"string"!=typeof t&&(a=$(t)),a.trigger("tab:init tab:mounted",e),n.emit("tabInit tabMounted",c[0],e),d&&d.length&&(u?h(function(){n.emit("routeChanged",n.currentRoute,n.previousRoute,n),n.params.unloadTabContent&&n.tabRemove(d,c,e)}):(n.emit("routeChanged",n.currentRoute,n.previousRoute,n),n.params.unloadTabContent&&n.tabRemove(d,c,e)))}(t))}function m(){return n.allowPageChange=!0,n}if(i)v(i);else if(o||l)try{n.tabTemplateLoader(o,l,a,v,m)}catch(e){throw n.allowPageChange=!0,e}else if(s)v(s);else if(p||f)try{n.tabComponentLoader(c[0],p,f,a,v,m)}catch(e){throw n.allowPageChange=!0,e}else r&&(n.xhr&&(n.xhr.abort(),n.xhr=!1),n.xhrRequest(r,a).then(function(e){v(e)}).catch(function(){n.allowPageChange=!0}))}return"url content component el componentUrl template templateUrl".split(" ").forEach(function(t){var a;e[t]&&(l=!0,v(((a={})[t]=e[t],a),i))}),e.async?e.async.call(n,a,r,function(e,t){v(e,Utils.extend(i,t))},function(){n.allowPageChange=!0}):l||(n.allowPageChange=!0),n}function tabRemove(e,t,a){var r;e[0]&&(e[0].f7RouterTabLoaded=!1,delete e[0].f7RouterTabLoaded),e.children().each(function(e,t){t.f7Component&&(r=!0,$(t).trigger("tab:beforeremove",a),t.f7Component.$destroy())}),r||e.trigger("tab:beforeremove",a),this.emit("tabBeforeRemove",e[0],t[0],a),this.removeTabContent(e[0],a)}function modalLoad(e,t,a){void 0===a&&(a={});var r,n=this,i=n.app,s="panel"===e,o=s?"panel":"modal",l=Utils.extend({animate:n.params.animate,pushState:!0,history:!0,on:{}},a),p=Utils.extend({},t.route[e]),c=t.route;function d(){var a=i[e].create(p);c.modalInstance=a;var r=a.el;function d(){a.close()}a.on(o+"Open",function(){r||(n.removeThemeElements(a.el),a.$el.trigger(e.toLowerCase()+":init "+e.toLowerCase()+":mounted",t,a),n.emit((s?"":"modalInit")+" "+e+"Init "+e+"Mounted",a.el,t,a)),n.once("swipeBackMove",d)}),a.on(o+"Close",function(){n.off("swipeBackMove",d),a.closeByRouter||n.back()}),a.on(o+"Closed",function(){a.$el.trigger(e.toLowerCase()+":beforeremove",t,a),a.emit((s?"":"modalBeforeRemove ")+e+"BeforeRemove",a.el,t,a);var r=a.el.f7Component;r&&r.$destroy(),Utils.nextTick(function(){(r||p.component)&&n.removeModal(a.el),a.destroy(),delete a.route,delete c.modalInstance})}),l.route&&(n.params.pushState&&l.pushState&&History.push(n.view.id,{url:l.route.url,modal:e},(n.params.pushStateRoot||"")+n.params.pushStateSeparator+l.route.url),l.route!==n.currentRoute&&(a.route=Utils.extend(l.route,{modal:a}),n.currentRoute=a.route),l.history&&(n.history.push(l.route.url),n.saveHistory())),r&&(n.removeThemeElements(a.el),a.$el.trigger(e.toLowerCase()+":init "+e.toLowerCase()+":mounted",t,a),n.emit(o+"Init "+e+"Init "+e+"Mounted",a.el,t,a)),a.open()}function u(e,t){var a=e.url,r=e.content,s=e.template,o=e.templateUrl,l=e.component,c=e.componentUrl;function u(e){e&&("string"==typeof e?p.content=e:e.f7Component?e.f7Component.$mount(function(e){p.el=e,i.root.append(e)}):p.el=e,d())}function h(){return n.allowPageChange=!0,n}if(r)u(r);else if(s||o)try{n.modalTemplateLoader(s,o,t,u,h)}catch(e){throw n.allowPageChange=!0,e}else if(l||c)try{n.modalComponentLoader(i.root[0],l,c,t,u,h)}catch(e){throw n.allowPageChange=!0,e}else a?(n.xhr&&(n.xhr.abort(),n.xhr=!1),n.xhrRequest(a,t).then(function(e){p.content=e,d()}).catch(function(){n.allowPageChange=!0})):d()}return"url content component el componentUrl template templateUrl".split(" ").forEach(function(e){var t;p[e]&&!r&&(r=!0,u(((t={})[e]=p[e],t),l))}),r||"actions"!==e||d(),p.async&&p.async.call(n,l.route,n.currentRoute,function(e,t){u(e,Utils.extend(l,t))},function(){n.allowPageChange=!0}),n}function modalRemove(e){Utils.extend(e,{closeByRouter:!0}),e.close()}function backward(e,t){var a,r,n,i,s,o,l=this,p=$(e),c=l.app,d=l.view,u=Utils.extend({animate:l.params.animate,pushState:!0},t),h=l.params.masterDetailBreakpoint>0,f=h&&u.route&&u.route.route&&!0===u.route.route.master,v=l.dynamicNavbar,m=l.separateNavbar,g=p,b=l.$el.children(".page-current"),y=h&&b.hasClass("page-master");if(g.length&&l.removeThemeElements(g),v&&(n=g.children(".navbar").children(".navbar-inner"),m?(r=l.$navbarEl,n.length>0&&g.children(".navbar").remove(),0===n.length&&g[0]&&g[0].f7Page&&(n=g[0].f7Page.$navbarEl),i=r.find(".navbar-current")):i=b.children(".navbar").children(".navbar-inner")),l.allowPageChange=!1,0===g.length||0===b.length)return l.allowPageChange=!0,l;if(l.removeThemeElements(g),u.route&&u.route.route&&u.route.route.keepAlive&&!u.route.route.keepAliveData&&(u.route.route.keepAliveData={pageEl:p[0]}),h){for(var w=l.$el.children(".page:not(.stacked)").filter(function(e,t){return t!==g[0]}),C=0;C<w.length;C+=1)a||!w[C].classList.contains("page-master")||(a=w[C]);s=!f&&a&&l.history.indexOf(u.route.url)>l.history.indexOf(a.f7Page.route.url)}if(g.addClass("page-previous"+(f?" page-master":"")+(s?" page-master-detail":"")).removeClass("stacked").removeAttr("aria-hidden").trigger("page:unstack").trigger("page:position",{position:"previous"}),(f||s)&&g.trigger("page:role",{role:f?"master":"detail"}),v&&n.length>0&&n.addClass("navbar-previous"+(f?" navbar-master":"")+(s?" navbar-master-detail":"")).removeClass("stacked").removeAttr("aria-hidden"),u.force&&(b.prev(".page-previous:not(.stacked)").length>0||0===b.prev(".page-previous").length))if(l.history.indexOf(u.route.url)>=0?(o=l.history.length-l.history.indexOf(u.route.url)-1,l.history=l.history.slice(0,l.history.indexOf(u.route.url)+2),d.history=l.history):l.history[[l.history.length-2]]?l.history[l.history.length-2]=u.route.url:l.history.unshift(l.url),o&&l.params.stackPages)b.prevAll(".page-previous").each(function(e,t){var a,r=$(t);m&&(a=$(c.navbar.getElByPage(r))),r[0]!==g[0]&&r.index()>g.index()&&(l.initialPages.indexOf(r[0])>=0?(r.addClass("stacked"),r.trigger("page:stack"),m&&a.addClass("stacked")):(l.pageCallback("beforeRemove",r,a,"previous",void 0,u),l.removePage(r),m&&a.length>0&&l.removeNavbar(a)))});else{var x,E=b.prev(".page-previous:not(.stacked)");m&&(x=$(c.navbar.getElByPage(E))),l.params.stackPages&&l.initialPages.indexOf(E[0])>=0?(E.addClass("stacked"),E.trigger("page:stack"),x.addClass("stacked")):E.length>0&&(l.pageCallback("beforeRemove",E,x,"previous",void 0,u),l.removePage(E),m&&x.length&&l.removeNavbar(x))}var k,S,T=g.parents(doc).length>0,M=g[0].f7Component;function P(){0===g.next(b).length&&(!T&&M?M.$mount(function(e){$(e).insertBefore(b)}):g.insertBefore(b)),m&&n.length&&(n.children(".title-large").length&&n.addClass("navbar-inner-large"),n.insertBefore(i),i.length>0?n.insertBefore(i):(l.$navbarEl.parents(doc).length||l.$el.prepend(l.$navbarEl),r.append(n))),T?u.route&&u.route.route&&u.route.route.keepAlive&&!g[0].f7PageMounted&&(g[0].f7PageMounted=!0,l.pageCallback("mounted",g,n,"previous","current",u,b)):l.pageCallback("mounted",g,n,"previous","current",u,b)}if(u.preload){P(),u.route.route.tab&&l.tabLoad(u.route.route.tab,Utils.extend({},u,{history:!1,pushState:!1,preload:!0})),f&&(g.removeClass("page-master-stacked").trigger("page:masterunstack"),m&&$(c.navbar.getElByPage(g)).removeClass("navbar-master-stacked")),l.pageCallback("init",g,n,"previous","current",u,b);var O=g.prevAll(".page-previous:not(.stacked):not(.page-master)");return O.length>0&&O.each(function(e,t){var a,r=$(t);m&&(a=$(c.navbar.getElByPage(r))),l.params.stackPages&&l.initialPages.indexOf(t)>=0?(r.addClass("stacked"),r.trigger("page:stack"),m&&a.addClass("stacked")):(l.pageCallback("beforeRemove",r,a,"previous",void 0),l.removePage(r),m&&a.length&&l.removeNavbar(a))}),l.allowPageChange=!0,l}function D(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";g.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),b.removeClass(e).addClass("page-next").attr("aria-hidden","true").trigger("page:position",{position:"next"}),v&&(n.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),i.removeClass(t).addClass("navbar-next").attr("aria-hidden","true")),l.pageCallback("afterIn",g,n,"previous","current",u),l.pageCallback("afterOut",b,i,"current","next",u),l.params.stackPages&&l.initialPages.indexOf(b[0])>=0?(b.addClass("stacked"),b.trigger("page:stack"),m&&i.addClass("stacked")):(l.pageCallback("beforeRemove",b,i,"next",void 0,u),l.removePage(b),m&&i.length&&l.removeNavbar(i)),l.allowPageChange=!0,l.emit("routeChanged",l.currentRoute,l.previousRoute,l),(l.params.preloadPreviousPage||l.params[c.theme+"SwipeBack"])&&l.history[l.history.length-2]&&!f&&l.back(l.history[l.history.length-2],{preload:!0}),l.params.pushState&&History.clearRouterQueue()}return Device.ie||Device.edge||Device.firefox&&!Device.ios||l.params.pushState&&u.pushState&&(o?History.go(-o):History.back()),1===l.history.length&&l.history.unshift(l.url),l.history.pop(),l.saveHistory(),l.currentPageEl=g[0],v&&n.length?l.currentNavbarEl=n[0]:delete l.currentNavbarEl,l.currentRoute=u.route,(Device.ie||Device.edge||Device.firefox&&!Device.ios)&&l.params.pushState&&u.pushState&&(o?History.go(-o):History.back()),P(),u.route.route.tab&&l.tabLoad(u.route.route.tab,Utils.extend({},u,{history:!1,pushState:!1})),l.pageCallback("init",g,n,"previous","current",u,b),l.pageCallback("beforeIn",g,n,"previous","current",u),l.pageCallback("beforeOut",b,i,"current","next",u),!u.animate||y&&c.width>=l.params.masterDetailBreakpoint?D():(k="page-previous page-current page-next",S="navbar-previous navbar-current navbar-next",b.removeClass(k).addClass("page-current").trigger("page:position",{position:"current"}),g.removeClass(k).addClass("page-previous").removeAttr("aria-hidden").trigger("page:position",{position:"previous"}),v&&(i.removeClass(S).addClass("navbar-current"),n.removeClass(S).addClass("navbar-previous").removeAttr("aria-hidden")),l.animate(b,g,i,n,"backward",function(){D()})),l}function loadBack(e,t,a){var r=this;if(!r.allowPageChange&&!a)return r;var n=e,i=t,s=n.url,o=n.content,l=n.el,p=n.pageName,c=n.template,d=n.templateUrl,u=n.component,h=n.componentUrl;if(i.route.url&&r.url===i.route.url&&!i.reloadCurrent&&!i.reloadPrevious&&!r.params.allowDuplicateUrls)return!1;function f(e,t){return r.backward(e,Utils.extend(i,t))}function v(){return r.allowPageChange=!0,r}if(!i.route&&s&&(i.route=r.parseRouteUrl(s)),(s||d||h)&&(r.allowPageChange=!1),o)r.backward(r.getPageEl(o),i);else if(c||d)try{r.pageTemplateLoader(c,d,i,f,v)}catch(e){throw r.allowPageChange=!0,e}else if(l)r.backward(r.getPageEl(l),i);else if(p)r.backward(r.$el.children('.page[data-name="'+p+'"]').eq(0),i);else if(u||h)try{r.pageComponentLoader(r.el,u,h,i,f,v)}catch(e){throw r.allowPageChange=!0,e}else s&&(r.xhr&&(r.xhr.abort(),r.xhr=!1),r.xhrRequest(s,i).then(function(e){r.backward(r.getPageEl(e),i)}).catch(function(){r.allowPageChange=!0}));return r}function back(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,n,i=this;if(i.swipeBackActive)return i;"object"==typeof e[0]?r=e[0]||{}:(a=e[0],r=e[1]||{});var s=r.name,o=r.params,l=r.query;if(s){if(!(n=i.findRouteByKey("name",s)))throw new Error('Framework7: route with name "'+s+'" not found');if(a=i.constructRouteUrl(n,{params:o,query:l}))return i.back(a,Utils.extend({},r,{name:null,params:null,query:null}));throw new Error("Framework7: can't construct URL for route with name \""+s+'"')}var p=i.app;appRouterCheck(i,"back");var c,d=i.currentRoute.modal;if(d||"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(e){i.currentRoute.route[e]&&(d=!0,c=e)}),d){var u,h=i.currentRoute.modal||i.currentRoute.route.modalInstance||p[c].get(),f=i.history[i.history.length-2];if(h&&h.$el){var v=h.$el.prevAll(".modal-in");v.length&&v[0].f7Modal&&(u=v[0].f7Modal.route)}if(u||(u=i.findMatchingRoute(f)),!u&&f&&(u={url:f,path:f.split("?")[0],query:Utils.parseUrlQuery(f),route:{path:f.split("?")[0],url:f}}),!(a&&0!==a.replace(/[# ]/g,"").trim().length||u&&h))return i;var m=r.force&&u&&a;return u&&h?(i.params.pushState&&!1!==r.pushState&&History.back(),i.currentRoute=u,i.history.pop(),i.saveHistory(),i.modalRemove(h),m&&i.navigate(a,{reloadCurrent:!0})):h&&(i.modalRemove(h),a&&i.navigate(a,{reloadCurrent:!0})),i}var g,b=i.$el.children(".page-current").prevAll(".page-previous:not(.page-master)").eq(0);if(i.params.masterDetailBreakpoint>0){var y=i.$el.children(".page-current").prevAll(".page-master").eq(0);if(y.length){var w=i.history[i.history.length-2],C=i.findMatchingRoute(w);C&&C.route===y[0].f7Page.route.route&&(b=y,r.preload||(g=p.width>=i.params.masterDetailBreakpoint))}}if(!r.force&&b.length&&!g){if(i.params.pushState&&b[0].f7Page&&i.history[i.history.length-2]!==b[0].f7Page.route.url)return i.back(i.history[i.history.length-2],Utils.extend(r,{force:!0})),i;var x=b[0].f7Page.route;return processRouteQueue.call(i,x,i.currentRoute,function(){i.loadBack({el:b},Utils.extend(r,{route:x}))},function(){}),i}if("#"===a&&(a=void 0),a&&"/"!==a[0]&&0!==a.indexOf("#")&&(a=((i.path||"/")+a).replace("//","/")),!a&&i.history.length>1&&(a=i.history[i.history.length-2]),g&&!r.force&&i.history[i.history.length-3])return i.back(i.history[i.history.length-3],Utils.extend({},r||{},{force:!0,animate:!1}));if(g&&!r.force)return i;if((n=i.findMatchingRoute(a))||a&&(n={url:a,path:a.split("?")[0],query:Utils.parseUrlQuery(a),route:{path:a.split("?")[0],url:a}}),!n)return i;if(n.route.redirect)return redirect.call(i,"back",n,r);var $,E={};if(n.route.options?Utils.extend(E,n.route.options,r):Utils.extend(E,r),E.route=n,E&&E.context&&(n.context=E.context,E.route.context=E.context),E.force&&i.params.stackPages&&(i.$el.children(".page-previous.stacked").each(function(e,t){t.f7Page&&t.f7Page.route&&t.f7Page.route.url===n.url&&($=!0,i.loadBack({el:t},E))}),$))return i;function k(){var e=!1;n.route.keepAlive&&n.route.keepAliveData&&(i.loadBack({el:n.route.keepAliveData.pageEl},E),e=!0),"url content component pageName el componentUrl template templateUrl".split(" ").forEach(function(t){var a;n.route[t]&&!e&&(e=!0,i.loadBack(((a={})[t]=n.route[t],a),E))}),e||n.route.async&&(i.allowPageChange=!1,n.route.async.call(i,n,i.currentRoute,function(e,t){i.allowPageChange=!1,t&&t.context&&(n.context?n.context=Utils.extend({},n.context,t.context):n.context=t.context,E.route.context=n.context),i.loadBack(e,Utils.extend(E,t),!0)},function(){i.allowPageChange=!0}))}function S(){i.allowPageChange=!0}return E.preload?k():processRouteQueue.call(i,n,i.currentRoute,function(){n.route.modules?p.loadModules(Array.isArray(n.route.modules)?n.route.modules:[n.route.modules]).then(function(){k()}).catch(function(){S()}):k()},function(){S()}),i}function clearPreviousPages(){var e=this;appRouterCheck(e,"clearPreviousPages");var t=e.app,a=e.separateNavbar;e.$el.children(".page").filter(function(t,a){return!(!e.currentRoute||!e.currentRoute.modal&&!e.currentRoute.panel)||a!==e.currentPageEl}).each(function(r,n){var i=$(n),s=$(t.navbar.getElByPage(i));e.params.stackPages&&e.initialPages.indexOf(i[0])>=0?(i.addClass("stacked"),a&&s.addClass("stacked")):(e.pageCallback("beforeRemove",i,s,"previous",void 0,{}),e.removePage(i),a&&s.length&&e.removeNavbar(s))})}function clearPreviousHistory(){appRouterCheck(this,"clearPreviousHistory");var e=this.history[this.history.length-1];this.clearPreviousPages(),this.history=[e],this.view.history=[e],this.saveHistory()}var Router=function(e){function t(t,a){e.call(this,{},[void 0===a?t:a]);var r=this;r.isAppRouter=void 0===a,r.isAppRouter?Utils.extend(!1,r,{app:t,params:t.params.view,routes:t.routes||[],cache:t.cache}):Utils.extend(!1,r,{app:t,view:a,viewId:a.id,params:a.params,routes:a.routes,$el:a.$el,el:a.el,$navbarEl:a.$navbarEl,navbarEl:a.navbarEl,history:a.history,scrollHistory:a.scrollHistory,cache:t.cache,dynamicNavbar:"ios"===t.theme&&a.params.iosDynamicNavbar,separateNavbar:"ios"===t.theme&&a.params.iosDynamicNavbar&&a.params.iosSeparateDynamicNavbar,initialPages:[],initialNavbars:[]}),r.useModules(),r.tempDom=doc.createElement("div"),r.allowPageChange=!0;var n={},i={};return Object.defineProperty(r,"currentRoute",{enumerable:!0,configurable:!0,set:function(e){void 0===e&&(e={}),i=Utils.extend({},n),(n=e)&&(r.url=n.url,r.emit("routeChange",e,i,r))},get:function(){return n}}),Object.defineProperty(r,"previousRoute",{enumerable:!0,configurable:!0,get:function(){return i},set:function(e){i=e}}),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.animatableNavElements=function(e,t,a,r,n){var i,s,o=this.dynamicNavbar,l=this.separateNavbar,p=this.params.iosAnimateNavbarBackIcon;function c(e,t){var a,r=e.hasClass("sliding")||t.hasClass("sliding"),n=e.hasClass("subnavbar"),i=!r||!n,s=e.find(".back .icon");return r&&p&&e.hasClass("left")&&s.length>0&&s.next("span").length&&(e=s.next("span"),a=!0),{$el:e,isIconLabel:a,leftOffset:e[0].f7NavbarLeftOffset,rightOffset:e[0].f7NavbarRightOffset,isSliding:r,isSubnavbar:n,needsOpacityTransition:i}}return o&&(i=[],s=[],e.children(".left, .right, .title, .subnavbar").each(function(t,s){var o=$(s);o.hasClass("left")&&r&&"forward"===n&&l||o.hasClass("title")&&a||i.push(c(o,e))}),t.hasClass("navbar-master")&&this.params.masterDetailBreakpoint>0&&this.app.width>=this.params.masterDetailBreakpoint||t.children(".left, .right, .title, .subnavbar").each(function(e,i){var o=$(i);o.hasClass("left")&&a&&!r&&"forward"===n&&l||o.hasClass("left")&&a&&"backward"===n&&l||o.hasClass("title")&&r||s.push(c(o,t))}),[s,i].forEach(function(e){e.forEach(function(t){var a=t,r=t.isSliding,n=t.$el,o=e===s?i:s;r&&n.hasClass("title")&&o&&o.forEach(function(e){if(e.isIconLabel){var t=e.$el[0];a.leftOffset+=t&&t.offsetLeft||0}})})})),{newNavEls:i,oldNavEls:s}},t.prototype.animate=function(e,t,a,r,n,i){var s=this;if(s.params.animateCustom)s.params.animateCustom.apply(s,[e,t,a,r,n,i]);else{var o,l,p,c,d,u,h=s.dynamicNavbar,f="ios"===s.app.theme,v="router-transition-"+n+" router-transition";if(f&&h){d=a&&a.hasClass("navbar-inner-large"),u=r&&r.hasClass("navbar-inner-large"),p=d&&!a.hasClass("navbar-inner-large-collapsed"),c=u&&!r.hasClass("navbar-inner-large-collapsed");var m=s.animatableNavElements(r,a,c,p,n);o=m.newNavEls,l=m.oldNavEls}("forward"===n?t:e).animationEnd(function(){s.dynamicNavbar&&(r&&(r.removeClass("router-navbar-transition-to-large router-navbar-transition-from-large"),r.addClass("navbar-no-title-large-transition"),Utils.nextFrame(function(){r.removeClass("navbar-no-title-large-transition")})),a&&a.removeClass("router-navbar-transition-to-large router-navbar-transition-from-large"),r.hasClass("sliding")?r.find(".title, .left, .right, .left .icon, .subnavbar").transform(""):r.find(".sliding").transform(""),a.hasClass("sliding")?a.find(".title, .left, .right, .left .icon, .subnavbar").transform(""):a.find(".sliding").transform("")),s.$el.removeClass(v),i&&i()}),h?(g(0),Utils.nextFrame(function(){g(1),s.$el.addClass(v)})):s.$el.addClass(v)}function g(e){f&&h&&(1===e&&(c&&(r.addClass("router-navbar-transition-to-large"),a.addClass("router-navbar-transition-to-large")),p&&(r.addClass("router-navbar-transition-from-large"),a.addClass("router-navbar-transition-from-large"))),o.forEach(function(t){var a=t.$el,r="forward"===n?t.rightOffset:t.leftOffset;t.isSliding&&(t.isSubnavbar&&u?a[0].style.setProperty("transform","translate3d("+r*(1-e)+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)","important"):a.transform("translate3d("+r*(1-e)+"px,0,0)"))}),l.forEach(function(t){var a=t.$el,r="forward"===n?t.leftOffset:t.rightOffset;t.isSliding&&(t.isSubnavbar&&d?a.transform("translate3d("+r*e+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)"):a.transform("translate3d("+r*e+"px,0,0)"))}))}},t.prototype.removeModal=function(e){this.removeEl(e)},t.prototype.removeTabContent=function(e){$(e).html("")},t.prototype.removeNavbar=function(e){this.removeEl(e)},t.prototype.removePage=function(e){var t=$(e),a=t&&t[0]&&t[0].f7Page;a&&a.route&&a.route.route&&a.route.route.keepAlive?t.remove():this.removeEl(e)},t.prototype.removeEl=function(e){if(e){var t=$(e);0!==t.length&&(t.find(".tab").each(function(e,t){$(t).children().each(function(e,t){t.f7Component&&($(t).trigger("tab:beforeremove"),t.f7Component.$destroy())})}),t[0].f7Component&&t[0].f7Component.$destroy&&t[0].f7Component.$destroy(),this.params.removeElements&&(this.params.removeElementsWithTimeout?setTimeout(function(){t.remove()},this.params.removeElementsTimeout):t.remove()))}},t.prototype.getPageEl=function(e){if("string"==typeof e)this.tempDom.innerHTML=e;else{if($(e).hasClass("page"))return e;this.tempDom.innerHTML="",$(this.tempDom).append(e)}return this.findElement(".page",this.tempDom)},t.prototype.findElement=function(e,t,a){var r=this.view,n=this.app,i=$(t),s=e;a&&(s+=":not(.stacked)");var o=i.find(s).filter(function(e,t){return 0===$(t).parents(".popup, .dialog, .popover, .actions-modal, .sheet-modal, .login-screen, .page").length});return o.length>1&&("string"==typeof r.selector&&(o=i.find(r.selector+" "+s)),o.length>1&&(o=i.find("."+n.params.viewMainClass+" "+s))),1===o.length?o:(a||(o=this.findElement(s,i,!0)),o&&1===o.length?o:o&&o.length>1?$(o[0]):void 0)},t.prototype.flattenRoutes=function(e){void 0===e&&(e=this.routes);var t=this,a=[];return e.forEach(function(e){var r=!1;if("tabs"in e&&e.tabs){var n=e.tabs.map(function(t){var a=Utils.extend({},e,{path:(e.path+"/"+t.path).replace("///","/").replace("//","/"),parentPath:e.path,tab:t});return delete a.tabs,delete a.routes,a});r=!0,a=a.concat(t.flattenRoutes(n))}if("detailRoutes"in e){var i=e.detailRoutes.map(function(t){var a=Utils.extend({},t);return a.masterRoute=e,a.masterRoutePath=e.path,a});a=a.concat(e,t.flattenRoutes(i))}if("routes"in e){var s=e.routes.map(function(t){var a=Utils.extend({},t);return a.path=(e.path+"/"+a.path).replace("///","/").replace("//","/"),a});a=r?a.concat(t.flattenRoutes(s)):a.concat(e,t.flattenRoutes(s))}"routes"in e||"tabs"in e&&e.tabs||"detailRoutes"in e||a.push(e)}),a},t.prototype.parseRouteUrl=function(e){if(!e)return{};var t=Utils.parseUrlQuery(e),a=e.split("#")[1],r=e.split("#")[0].split("?")[0];return{query:t,hash:a,params:{},url:e,path:r}},t.prototype.constructRouteUrl=function(e,t){void 0===t&&(t={});var a,r=t.params,n=t.query,i=e.path,s=pathToRegexp_1.compile(i);try{a=s(r||{})}catch(e){throw new Error("Framework7: error constructing route URL from passed params:\nRoute: "+i+"\n"+e.toString())}return n&&(a+="string"==typeof n?"?"+n:"?"+Utils.serializeObject(n)),a},t.prototype.findTabRoute=function(e){var t,a=$(e),r=this.currentRoute.route.parentPath,n=a.attr("id");return this.flattenRoutes(this.routes).forEach(function(e){e.parentPath===r&&e.tab&&e.tab.id===n&&(t=e)}),t},t.prototype.findRouteByKey=function(e,t){var a,r=this.routes;return this.flattenRoutes(r).forEach(function(r){a||r[e]===t&&(a=r)}),a},t.prototype.findMatchingRoute=function(e){if(e){var t,a=this.routes,r=this.flattenRoutes(a),n=this.parseRouteUrl(e),i=n.path,s=n.query,o=n.hash,l=n.params;return r.forEach(function(a){if(!t){var r,n,p=[],c=[a.path];if(a.alias&&("string"==typeof a.alias?c.push(a.alias):Array.isArray(a.alias)&&a.alias.forEach(function(e){c.push(e)})),c.forEach(function(e){r||(r=pathToRegexp_1(e,p).exec(i))}),r)p.forEach(function(e,t){if("number"!=typeof e.name){var a=r[t+1];l[e.name]=a}}),a.parentPath&&(n=i.split("/").slice(0,a.parentPath.split("/").length-1).join("/")),t={query:s,hash:o,params:l,url:e,path:i,parentPath:n,route:a,name:a.name}}}),t}},t.prototype.replaceRequestUrlParams=function(e,t){void 0===e&&(e=""),void 0===t&&(t={});var a=e;return"string"==typeof a&&a.indexOf("{{")>=0&&t&&t.route&&t.route.params&&Object.keys(t.route.params).length&&Object.keys(t.route.params).forEach(function(e){var r=new RegExp("{{"+e+"}}","g");a=a.replace(r,t.route.params[e]||"")}),a},t.prototype.removeFromXhrCache=function(e){for(var t=this.cache.xhr,a=!1,r=0;r<t.length;r+=1)t[r].url===e&&(a=r);!1!==a&&t.splice(a,1)},t.prototype.xhrRequest=function(e,t){var a=this,r=a.params,n=t.ignoreCache,i=e,s=i.indexOf("?")>=0;return r.passRouteQueryToRequest&&t&&t.route&&t.route.query&&Object.keys(t.route.query).length&&(i+=(s?"&":"?")+Utils.serializeObject(t.route.query),s=!0),r.passRouteParamsToRequest&&t&&t.route&&t.route.params&&Object.keys(t.route.params).length&&(i+=(s?"&":"?")+Utils.serializeObject(t.route.params),s=!0),i.indexOf("{{")>=0&&(i=a.replaceRequestUrlParams(i,t)),r.xhrCacheIgnoreGetParameters&&i.indexOf("?")>=0&&(i=i.split("?")[0]),new Promise(function(e,s){if(r.xhrCache&&!n&&i.indexOf("nocache")<0&&r.xhrCacheIgnore.indexOf(i)<0)for(var o=0;o<a.cache.xhr.length;o+=1){var l=a.cache.xhr[o];if(l.url===i&&Utils.now()-l.time<r.xhrCacheDuration)return void e(l.content)}a.xhr=a.app.request({url:i,method:"GET",beforeSend:function(e){a.emit("routerAjaxStart",e,t)},complete:function(n,o){a.emit("routerAjaxComplete",n),"error"!==o&&"timeout"!==o&&n.status>=200&&n.status<300||0===n.status?(r.xhrCache&&""!==n.responseText&&(a.removeFromXhrCache(i),a.cache.xhr.push({url:i,time:Utils.now(),content:n.responseText})),a.emit("routerAjaxSuccess",n,t),e(n.responseText)):(a.emit("routerAjaxError",n,t),s(n))},error:function(e){a.emit("routerAjaxError",e,t),s(e)}})})},t.prototype.removeThemeElements=function(e){var t,a=this.app.theme;"ios"===a?t=".md-only, .aurora-only, .if-md, .if-aurora, .if-not-ios, .not-ios":"md"===a?t=".ios-only, .aurora-only, .if-ios, .if-aurora, .if-not-md, .not-md":"aurora"===a&&(t=".ios-only, .md-only, .if-ios, .if-md, .if-not-aurora, .not-aurora"),$(e).find(t).remove()},t.prototype.getPageData=function(e,t,a,r,n,i){void 0===n&&(n={});var s,o,l=$(e).eq(0),p=$(t).eq(0),c=l[0].f7Page||{};if(("next"===a&&"current"===r||"current"===a&&"previous"===r)&&(s="forward"),("current"===a&&"next"===r||"previous"===a&&"current"===r)&&(s="backward"),c&&!c.fromPage){var d=$(i);d.length&&(o=d[0].f7Page)}(o=c.pageFrom||o)&&o.pageFrom&&(o.pageFrom=null);var u={app:this.app,view:this.view,router:this,$el:l,el:l[0],$pageEl:l,pageEl:l[0],$navbarEl:p,navbarEl:p[0],name:l.attr("data-name"),position:a,from:a,to:r,direction:s,route:c.route?c.route:n,pageFrom:o};return l[0].f7Page=u,u},t.prototype.pageCallback=function(e,t,a,r,n,i,s){if(void 0===i&&(i={}),t){var o=this,l=$(t);if(l.length){var p=$(a),c=i.route,d=o.params.restoreScrollTopOnBack&&!(o.params.masterDetailBreakpoint>0&&l.hasClass("page-master")&&o.app.width>=o.params.masterDetailBreakpoint),u=l[0].f7Page&&l[0].f7Page.route&&l[0].f7Page.route.route&&l[0].f7Page.route.route.keepAlive;"beforeRemove"===e&&u&&(e="beforeUnmount");var h="page"+(e[0].toUpperCase()+e.slice(1,e.length)),f="page:"+e.toLowerCase(),v={};(v="beforeRemove"===e&&l[0].f7Page?Utils.extend(l[0].f7Page,{from:r,to:n,position:r}):o.getPageData(l[0],p[0],r,n,c,s)).swipeBack=!!i.swipeBack;var m=i.route?i.route.route:{},g=m.on;void 0===g&&(g={});var b=m.once;if(void 0===b&&(b={}),i.on&&Utils.extend(g,i.on),i.once&&Utils.extend(b,i.once),"mounted"===e&&C(),"init"===e){if(d&&("previous"===r||!r)&&"current"===n&&o.scrollHistory[v.route.url]&&!l.hasClass("no-restore-scroll")){var y=l.find(".page-content");y.length>0&&(y=y.filter(function(e,t){return 0===$(t).parents(".tab:not(.tab-active)").length&&!$(t).is(".tab:not(.tab-active)")})),y.scrollTop(o.scrollHistory[v.route.url])}if(C(),l[0].f7PageInitialized)return l.trigger("page:reinit",v),void o.emit("pageReinit",v);l[0].f7PageInitialized=!0}if(d&&"beforeOut"===e&&"current"===r&&"previous"===n){var w=l.find(".page-content");w.length>0&&(w=w.filter(function(e,t){return 0===$(t).parents(".tab:not(.tab-active)").length&&!$(t).is(".tab:not(.tab-active)")})),o.scrollHistory[v.route.url]=w.scrollTop()}d&&"beforeOut"===e&&"current"===r&&"next"===n&&delete o.scrollHistory[v.route.url],l.trigger(f,v),o.emit(h,v),"beforeRemove"!==e&&"beforeUnmount"!==e||(l[0].f7RouteEventsAttached&&(l[0].f7RouteEventsOn&&Object.keys(l[0].f7RouteEventsOn).forEach(function(e){l.off(Utils.eventNameToColonCase(e),l[0].f7RouteEventsOn[e])}),l[0].f7RouteEventsOnce&&Object.keys(l[0].f7RouteEventsOnce).forEach(function(e){l.off(Utils.eventNameToColonCase(e),l[0].f7RouteEventsOnce[e])}),l[0].f7RouteEventsAttached=null,l[0].f7RouteEventsOn=null,l[0].f7RouteEventsOnce=null,delete l[0].f7RouteEventsAttached,delete l[0].f7RouteEventsOn,delete l[0].f7RouteEventsOnce),u||(l[0].f7Page&&l[0].f7Page.navbarEl&&delete l[0].f7Page.navbarEl.f7Page,l[0].f7Page=null))}}function C(){l[0].f7RouteEventsAttached||(l[0].f7RouteEventsAttached=!0,g&&Object.keys(g).length>0&&(l[0].f7RouteEventsOn=g,Object.keys(g).forEach(function(e){g[e]=g[e].bind(o),l.on(Utils.eventNameToColonCase(e),g[e])})),b&&Object.keys(b).length>0&&(l[0].f7RouteEventsOnce=b,Object.keys(b).forEach(function(e){b[e]=b[e].bind(o),l.once(Utils.eventNameToColonCase(e),b[e])})))}},t.prototype.saveHistory=function(){this.view.history=this.history,this.params.pushState&&(win.localStorage["f7router-"+this.view.id+"-history"]=JSON.stringify(this.history))},t.prototype.restoreHistory=function(){this.params.pushState&&win.localStorage["f7router-"+this.view.id+"-history"]&&(this.history=JSON.parse(win.localStorage["f7router-"+this.view.id+"-history"]),this.view.history=this.history)},t.prototype.clearHistory=function(){this.history=[],this.view&&(this.view.history=[]),this.saveHistory()},t.prototype.updateCurrentUrl=function(e){appRouterCheck(this,"updateCurrentUrl"),this.history.length?this.history[this.history.length-1]=e:this.history.push(e);var t=this.parseRouteUrl(e),a=t.query,r=t.hash,n=t.params,i=t.url,s=t.path;if(this.currentRoute&&Utils.extend(this.currentRoute,{query:a,hash:r,params:n,url:i,path:s}),this.params.pushState){var o=this.params.pushStateRoot||"";History.replace(this.view.id,{url:e},o+this.params.pushStateSeparator+e)}this.saveHistory(),this.emit("routeUrlUpdate",this.currentRoute,this)},t.prototype.init=function(){var e=this,t=e.app,a=e.view;(a&&e.params.iosSwipeBack&&"ios"===t.theme||a&&e.params.mdSwipeBack&&"md"===t.theme||a&&e.params.auroraSwipeBack&&"aurora"===t.theme)&&SwipeBack(e),e.dynamicNavbar&&!e.separateNavbar&&e.$el.addClass("router-dynamic-navbar-inside");var r,n,i,s=e.params.url,o=doc.location.href.split(doc.location.origin)[1],l=e.params,p=l.pushState,c=l.pushStateOnLoad,d=l.pushStateSeparator,u=l.pushStateAnimateOnLoad,h=e.params.pushStateRoot;(win.cordova&&p&&!d&&!h&&doc.location.pathname.indexOf("index.html")&&(console.warn("Framework7: wrong or not complete pushState configuration, trying to guess pushStateRoot"),h=doc.location.pathname.split("index.html")[0]),p&&c?(h&&o.indexOf(h)>=0&&""===(o=o.split(h)[1])&&(o="/"),s=d.length>0&&o.indexOf(d)>=0?o.split(d)[1]:o,e.restoreHistory(),e.history.indexOf(s)>=0?e.history=e.history.slice(0,e.history.indexOf(s)+1):e.params.url===s?e.history=[s]:History.state&&History.state[a.id]&&History.state[a.id].url===e.history[e.history.length-1]?s=e.history[e.history.length-1]:e.history=[o.split(d)[0]||"/",s],e.history.length>1?r=!0:e.history=[],e.saveHistory()):(s||(s=o),doc.location.search&&s.indexOf("?")<0&&(s+=doc.location.search),doc.location.hash&&s.indexOf("#")<0&&(s+=doc.location.hash)),e.history.length>1?(n=e.findMatchingRoute(e.history[0]))||(n=Utils.extend(e.parseRouteUrl(e.history[0]),{route:{url:e.history[0],path:e.history[0].split("?")[0]}})):(n=e.findMatchingRoute(s))||(n=Utils.extend(e.parseRouteUrl(s),{route:{url:s,path:s.split("?")[0]}})),e.params.stackPages&&e.$el.children(".page").each(function(t,a){var r=$(a);e.initialPages.push(r[0]),e.separateNavbar&&r.children(".navbar").length>0&&e.initialNavbars.push(r.children(".navbar").find(".navbar-inner")[0])}),0===e.$el.children(".page:not(.stacked)").length&&s)?e.navigate(s,{initial:!0,reloadCurrent:!0,pushState:!1}):(e.currentRoute=n,e.$el.children(".page:not(.stacked)").each(function(t,a){var r,n=$(a);n.addClass("page-current"),e.separateNavbar&&((r=n.children(".navbar").children(".navbar-inner")).length>0?(e.$navbarEl.parents(doc).length||e.$el.prepend(e.$navbarEl),r.addClass("navbar-current"),e.$navbarEl.append(r),r.children(".title-large").length&&r.addClass("navbar-inner-large"),n.children(".navbar").remove()):(e.$navbarEl.addClass("navbar-hidden"),r.children(".title-large").length&&e.$navbarEl.addClass("navbar-hidden navbar-large-hidden"))),e.currentRoute&&e.currentRoute.route&&e.currentRoute.route.master&&e.params.masterDetailBreakpoint>0&&(n.addClass("page-master"),n.trigger("page:role",{role:"master"}),r&&r.length&&r.addClass("navbar-master"));var s={route:e.currentRoute};e.currentRoute&&e.currentRoute.route&&e.currentRoute.route.options&&Utils.extend(s,e.currentRoute.route.options),e.currentPageEl=n[0],e.separateNavbar&&r.length&&(e.currentNavbarEl=r[0]),e.removeThemeElements(n),e.separateNavbar&&r.length&&e.removeThemeElements(r),s.route.route.tab&&(i=!0,e.tabLoad(s.route.route.tab,Utils.extend({},s))),e.pageCallback("init",n,r,"current",void 0,s)}),r&&e.navigate(s,{initial:!0,pushState:!1,history:!1,animate:u,once:{pageAfterIn:function(){(e.params.preloadPreviousPage||e.params[t.theme+"SwipeBack"])&&e.history.length>2&&e.back({preload:!0})}}}),r||i||(e.history.push(s),e.saveHistory()));!(s&&p&&c)||History.state&&History.state[a.id]||History.initViewState(a.id,{url:s}),e.emit("local::init routerInit",e)},t.prototype.destroy=function(){var e=this;e.emit("local::destroy routerDestroy",e),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},t}(Framework7Class);Router.prototype.forward=forward,Router.prototype.load=load,Router.prototype.navigate=navigate,Router.prototype.refreshPage=refreshPage,Router.prototype.tabLoad=tabLoad,Router.prototype.tabRemove=tabRemove,Router.prototype.modalLoad=modalLoad,Router.prototype.modalRemove=modalRemove,Router.prototype.backward=backward,Router.prototype.loadBack=loadBack,Router.prototype.back=back,Router.prototype.clearPreviousPages=clearPreviousPages,Router.prototype.clearPreviousHistory=clearPreviousHistory;var Router$1={name:"router",static:{Router:Router},instance:{cache:{xhr:[],templates:[],components:[]}},create:function(){this.app?this.params.router&&(this.router=new Router(this.app,this)):this.router=new Router(this)}},View=function(e){function t(t,a,r){void 0===r&&(r={}),e.call(this,r,[t]);var n,i,s,o=t,l=$(a),p=this;return p.params=Utils.extend({routes:[],routesAdd:[]},o.params.view,r),p.params.routes.length>0?p.routes=p.params.routes:p.routes=[].concat(o.routes,p.params.routesAdd),n="string"==typeof a?a:(l.attr("id")?"#"+l.attr("id"):"")+(l.attr("class")?"."+l.attr("class").replace(/ /g,".").replace(".active",""):""),"ios"===o.theme&&p.params.iosDynamicNavbar&&p.params.iosSeparateDynamicNavbar&&0===(i=l.children(".navbar").eq(0)).length&&(i=$('<div class="navbar"></div>')),Utils.extend(!1,p,{app:o,$el:l,el:l[0],name:p.params.name,main:p.params.main||l.hasClass("view-main"),$navbarEl:i,navbarEl:i?i[0]:void 0,selector:n,history:[],scrollHistory:{}}),l[0].f7View=p,p.useModules(),o.views.push(p),p.main&&(o.views.main=p),p.name&&(o.views[p.name]=p),p.index=o.views.indexOf(p),s=p.name?"view_"+p.name:p.main?"view_main":"view_"+p.index,p.id=s,o.initialized?p.init():o.on("init",function(){p.init()}),p}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.destroy=function(){var e=this,t=e.app;e.$el.trigger("view:beforedestroy",e),e.emit("local::beforeDestroy viewBeforeDestroy",e),t.off("resize",e.checkmasterDetailBreakpoint),e.main?(t.views.main=null,delete t.views.main):e.name&&(t.views[e.name]=null,delete t.views[e.name]),e.$el[0].f7View=null,delete e.$el[0].f7View,t.views.splice(t.views.indexOf(e),1),e.params.router&&e.router&&e.router.destroy(),e.emit("local::destroy viewDestroy",e),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},t.prototype.checkmasterDetailBreakpoint=function(){var e=this.app,t=this.$el.hasClass("view-master-detail");e.width>=this.params.masterDetailBreakpoint?(this.$el.addClass("view-master-detail"),t||(this.emit("local::masterDetailBreakpoint viewMasterDetailBreakpoint"),this.$el.trigger("view:masterDetailBreakpoint",this))):(this.$el.removeClass("view-master-detail"),t&&(this.emit("local::masterDetailBreakpoint viewMasterDetailBreakpoint"),this.$el.trigger("view:masterDetailBreakpoint",this)))},t.prototype.initMasterDetail=function(){var e=this.app;this.checkmasterDetailBreakpoint=this.checkmasterDetailBreakpoint.bind(this),this.checkmasterDetailBreakpoint(),e.on("resize",this.checkmasterDetailBreakpoint)},t.prototype.init=function(){this.params.router&&(this.params.masterDetailBreakpoint>0&&this.initMasterDetail(),this.router.init(),this.$el.trigger("view:init",this),this.emit("local::init viewInit",this))},t}(Framework7Class);function initClicks(e){e.on("click",function(t){var a=$(t.target),r=a.closest("a"),n=r.length>0,i=n&&r.attr("href"),s=n&&r.hasClass("tab-link")&&(r.attr("data-tab")||i&&0===i.indexOf("#"));if(n&&(r.is(e.params.clicks.externalLinks)||i&&i.indexOf("javascript:")>=0)){var o=r.attr("target");i&&win.cordova&&win.cordova.InAppBrowser&&("_system"===o||"_blank"===o)&&(t.preventDefault(),win.cordova.InAppBrowser.open(i,o))}else{Object.keys(e.modules).forEach(function(r){var n=e.modules[r].clicks;n&&Object.keys(n).forEach(function(r){var i=a.closest(r).eq(0);i.length>0&&n[r].call(e,i,i.dataset(),t)})});var l={};if(n&&(t.preventDefault(),l=r.dataset()),!r.hasClass("prevent-router")&&!r.hasClass("router-prevent")&&(i&&i.length>0&&"#"!==i&&!s||r.hasClass("back"))){var p;if(l.view?p=$(l.view)[0].f7View:(p=a.parents(".view")[0]&&a.parents(".view")[0].f7View,!r.hasClass("back")&&p&&p.params.linksView&&("string"==typeof p.params.linksView?p=$(p.params.linksView)[0].f7View:p.params.linksView instanceof View&&(p=p.params.linksView))),p||e.views.main&&(p=e.views.main),!p||!p.router)return;if(l.context&&"string"==typeof l.context)try{l.context=JSON.parse(l.context)}catch(e){}r[0].f7RouteProps&&(l.props=r[0].f7RouteProps),r.hasClass("back")?p.router.back(i,l):p.router.navigate(i,l)}}})}View.use(Router$1);var ClicksModule={name:"clicks",params:{clicks:{externalLinks:".external"}},on:{init:function(){initClicks(this)}}},RouterTemplateLoaderModule={name:"routerTemplateLoader",proto:{templateLoader:function(e,t,a,r,n){var i=this;function s(e){var t,s;try{if("function"==typeof(s=a.context||{}))s=s.call(i);else if("string"==typeof s)try{s=JSON.parse(s)}catch(e){throw n(),e}t="function"==typeof e?e(s):Template7.compile(e)(Utils.extend({},s||{},{$app:i.app,$root:Utils.extend({},i.app.data,i.app.methods),$route:a.route,$f7route:a.route,$router:i,$f7router:i,$theme:{ios:"ios"===i.app.theme,md:"md"===i.app.theme,aurora:"aurora"===i.app.theme}}))}catch(e){throw n(),e}r(t,{context:s})}t?(i.xhr&&(i.xhr.abort(),i.xhr=!1),i.xhrRequest(t,a).then(function(e){s(e)}).catch(function(){n()})):s(e)},modalTemplateLoader:function(e,t,a,r,n){return this.templateLoader(e,t,a,function(e){r(e)},n)},tabTemplateLoader:function(e,t,a,r,n){return this.templateLoader(e,t,a,function(e){r(e)},n)},pageTemplateLoader:function(e,t,a,r,n){var i=this;return i.templateLoader(e,t,a,function(e,t){void 0===t&&(t={}),r(i.getPageEl(e),t)},n)}}},RouterComponentLoaderModule={name:"routerComponentLoader",proto:{componentLoader:function(e,t,a,r,n){void 0===a&&(a={});var i,s=this,o=s.app,l="string"==typeof e?e:t,p=s.replaceRequestUrlParams(l,a);function c(e){var t=a.context||{};if("function"==typeof t)t=t.call(s);else if("string"==typeof t)try{t=JSON.parse(t)}catch(e){throw n(),e}var i=Utils.merge({},t,{$route:a.route,$f7route:a.route,$router:s,$f7router:s,$theme:{ios:"ios"===o.theme,md:"md"===o.theme,aurora:"aurora"===o.theme}}),l=o.component.create(e,i);r(l.el)}p&&s.cache.components.forEach(function(e){e.url===p&&(i=e.component)}),p&&i?c(i):p&&!i?(s.xhr&&(s.xhr.abort(),s.xhr=!1),s.xhrRequest(l,a).then(function(e){var t=o.component.parse(e);s.cache.components.push({url:p,component:t}),c(t)}).catch(function(e){throw n(),e})):c(e)},modalComponentLoader:function(e,t,a,r,n,i){this.componentLoader(t,a,r,function(e){n(e)},i)},tabComponentLoader:function(e,t,a,r,n,i){this.componentLoader(t,a,r,function(e){n(e)},i)},pageComponentLoader:function(e,t,a,r,n,i){this.componentLoader(t,a,r,function(e,t){void 0===t&&(t={}),n(e,t)},i)}}},HistoryModule={name:"history",static:{history:History},on:{init:function(){History.init(this)}}},keyPrefix="f7storage-",Storage={get:function(e){return new Promise(function(t,a){try{t(JSON.parse(win.localStorage.getItem(""+keyPrefix+e)))}catch(e){a(e)}})},set:function(e,t){return new Promise(function(a,r){try{win.localStorage.setItem(""+keyPrefix+e,JSON.stringify(t)),a()}catch(e){r(e)}})},remove:function(e){return new Promise(function(t,a){try{win.localStorage.removeItem(""+keyPrefix+e),t()}catch(e){a(e)}})},clear:function(){},length:function(){},keys:function(){return new Promise(function(e,t){try{e(Object.keys(win.localStorage).filter(function(e){return 0===e.indexOf(keyPrefix)}).map(function(e){return e.replace(keyPrefix,"")}))}catch(e){t(e)}})},forEach:function(e){return new Promise(function(t,a){try{Object.keys(win.localStorage).filter(function(e){return 0===e.indexOf(keyPrefix)}).forEach(function(t,a){var r=t.replace(keyPrefix,"");Storage.get(r).then(function(t){e(r,t,a)})}),t()}catch(e){a(e)}})}},StorageModule={name:"storage",static:{Storage:Storage,storage:Storage}};function vnode(e,t,a,r,n){return{sel:e,data:t,children:a,text:r,elm:n,key:void 0===t?void 0:t.key}}var array=Array.isArray;function primitive(e){return"string"==typeof e||"number"==typeof e}function addNS(e,t,a){if(e.ns="http://www.w3.org/2000/svg","foreignObject"!==a&&void 0!==t)for(var r=0;r<t.length;++r){var n=t[r].data;void 0!==n&&addNS(n,t[r].children,t[r].sel)}}function h(e,t,a){var r,n,i,s={};if(void 0!==a?(s=t,array(a)?r=a:primitive(a)?n=a:a&&a.sel&&(r=[a])):void 0!==t&&(array(t)?r=t:primitive(t)?n=t:t&&t.sel?r=[t]:s=t),array(r))for(i=0;i<r.length;++i)primitive(r[i])&&(r[i]=vnode(void 0,void 0,void 0,r[i],void 0));return"s"!==e[0]||"v"!==e[1]||"g"!==e[2]||3!==e.length&&"."!==e[3]&&"#"!==e[3]||addNS(s,r,e),vnode(e,s,r,n,void 0)}var selfClosing="area base br col command embed hr img input keygen link menuitem meta param source track wbr".split(" "),propsAttrs="hidden checked disabled readonly selected autocomplete autofocus autoplay required multiple value".split(" "),booleanProps="hidden checked disabled readonly selected autocomplete autofocus autoplay required multiple readOnly".split(" "),tempDom=doc.createElement("div");function getHooks(e,t,a,r){var n={};if(!e||!e.attrs||!e.attrs.class)return n;var i=e.attrs.class,s=[],o=[],l=[],p=[];return i.split(" ").forEach(function(e){a||s.push.apply(s,t.getVnodeHooks("insert",e)),o.push.apply(o,t.getVnodeHooks("destroy",e)),l.push.apply(l,t.getVnodeHooks("update",e)),p.push.apply(p,t.getVnodeHooks("postpatch",e))}),r&&!a&&p.push(function(e,t){var a=t||e;a&&a.data&&a.data.context&&a.data.context.$options.updated&&a.data.context.$options.updated()}),0===s.length&&0===o.length&&0===l.length&&0===p.length?n:(s.length&&(n.insert=function(e){s.forEach(function(t){return t(e)})}),o.length&&(n.destroy=function(e){o.forEach(function(t){return t(e)})}),l.length&&(n.update=function(e,t){l.forEach(function(a){return a(e,t)})}),p.length&&(n.postpatch=function(e,t){p.forEach(function(a){return a(e,t)})}),n)}function getEventHandler(e,t,a){void 0===a&&(a={});var r,n,i=a.stop,s=a.prevent,o=a.once,l=!1,p=[],c=!0;if((r=e.indexOf("(")<0?e:e.split("(")[0]).indexOf(".")>=0)r.split(".").forEach(function(e,a){if(0!==a||"this"!==e){if(0===a&&"window"===e)return n=win,void(c=!1);if(n||(n=t),!n[e])throw new Error("Framework7: Component doesn't have method \""+r.split(".").slice(0,a+1).join(".")+'"');n=n[e]}});else{if(!t[r])throw new Error("Framework7: Component doesn't have method \""+r+'"');n=t[r]}return c&&(n=n.bind(t)),function(){for(var a=[],r=arguments.length;r--;)a[r]=arguments[r];var c=a[0];o&&l||(i&&c.stopPropagation(),s&&c.preventDefault(),l=!0,e.indexOf("(")<0?p=a:e.split("(")[1].split(")")[0].split(",").forEach(function(e){var a=e.trim();if(isNaN(a))if("true"===a)a=!0;else if("false"===a)a=!1;else if("null"===a)a=null;else if("undefined"===a)a=void 0;else if('"'===a[0])a=a.replace(/"/g,"");else if("'"===a[0])a=a.replace(/'/g,"");else if(a.indexOf(".")>0){var r;a.split(".").forEach(function(e){r||(r=t),r=r[e]}),a=r}else a=t[a];else a=parseFloat(a);p.push(a)}),n.apply(void 0,p))}}function getData(e,t,a,r,n){var i={context:t},s=e.attributes;Array.prototype.forEach.call(s,function(e){var a=e.name,r=e.value;if(propsAttrs.indexOf(a)>=0)i.props||(i.props={}),"readonly"===a&&(a="readOnly"),booleanProps.indexOf(a)>=0?i.props[a]=!1!==r:i.props[a]=r;else if("key"===a)i.key=r;else if(0===a.indexOf("@")){i.on||(i.on={});var s=a.substr(1),o=!1,l=!1,p=!1;s.indexOf(".")>=0&&s.split(".").forEach(function(e,t){0===t?s=e:("stop"===e&&(o=!0),"prevent"===e&&(l=!0),"once"===e&&(p=!0))}),i.on[s]=getEventHandler(r,t,{stop:o,prevent:l,once:p})}else if("style"===a)if(r.indexOf("{")>=0&&r.indexOf("}")>=0)try{i.style=JSON.parse(r)}catch(e){i.attrs||(i.attrs={}),i.attrs.style=r}else i.attrs||(i.attrs={}),i.attrs.style=r;else i.attrs||(i.attrs={}),i.attrs[a]=r,"id"!==a||i.key||n||(i.key=r)});var o=getHooks(i,a,r,n);return o.prepatch=function(e,t){e&&t&&e&&e.data&&e.data.props&&Object.keys(e.data.props).forEach(function(a){booleanProps.indexOf(a)<0||(t.data||(t.data={}),t.data.props||(t.data.props={}),!0!==e.data.props[a]||a in t.data.props||(t.data.props[a]=!1))})},o&&(i.hook=o),i}function getChildren(e,t,a,r){for(var n=[],i=e.childNodes,s=0;s<i.length;s+=1){var o=elementToVNode(i[s],t,a,r);o&&n.push(o)}return n}function elementToVNode(e,t,a,r,n){if(1===e.nodeType){var i=e instanceof win.SVGElement?e.nodeName:e.nodeName.toLowerCase();return h(i,getData(e,t,a,r,n),selfClosing.indexOf(i)>=0?[]:getChildren(e,t,a,r))}return 3===e.nodeType?e.textContent:null}function vdom(e,t,a,r){var n;void 0===e&&(e=""),tempDom.innerHTML=e.trim();for(var i=0;i<tempDom.childNodes.length;i+=1)n||1!==tempDom.childNodes[i].nodeType||(n=tempDom.childNodes[i]);var s=elementToVNode(n,t,a,r,!0);return tempDom.innerHTML="",s}function createElement(e){return document.createElement(e)}function createElementNS(e,t){return document.createElementNS(e,t)}function createTextNode(e){return document.createTextNode(e)}function createComment(e){return document.createComment(e)}function insertBefore$1(e,t,a){e.insertBefore(t,a)}function removeChild(e,t){e&&e.removeChild(t)}function appendChild(e,t){e.appendChild(t)}function parentNode(e){return e.parentNode}function nextSibling(e){return e.nextSibling}function tagName(e){return e.tagName}function setTextContent(e,t){e.textContent=t}function getTextContent(e){return e.textContent}function isElement(e){return 1===e.nodeType}function isText(e){return 3===e.nodeType}function isComment(e){return 8===e.nodeType}var htmlDomApi={createElement:createElement,createElementNS:createElementNS,createTextNode:createTextNode,createComment:createComment,insertBefore:insertBefore$1,removeChild:removeChild,appendChild:appendChild,parentNode:parentNode,nextSibling:nextSibling,tagName:tagName,setTextContent:setTextContent,getTextContent:getTextContent,isElement:isElement,isText:isText,isComment:isComment};function isUndef(e){return void 0===e}function isDef(e){return void 0!==e}var emptyNode=vnode("",{},[],void 0,void 0);function sameVnode(e,t){return e.key===t.key&&e.sel===t.sel}function isVnode(e){return void 0!==e.sel}function createKeyToOldIdx(e,t,a){var r,n,i,s={};for(r=t;r<=a;++r)null!=(i=e[r])&&void 0!==(n=i.key)&&(s[n]=r);return s}var hooks=["create","update","remove","destroy","pre","post"];function init$1(e,t){var a,r,n={},i=void 0!==t?t:htmlDomApi;for(a=0;a<hooks.length;++a)for(n[hooks[a]]=[],r=0;r<e.length;++r){var s=e[r][hooks[a]];void 0!==s&&n[hooks[a]].push(s)}function o(e,t){return function(){if(0==--t){var a=i.parentNode(e);i.removeChild(a,e)}}}function l(e,t){var a,r=e.data;void 0!==r&&isDef(a=r.hook)&&isDef(a=a.init)&&(a(e),r=e.data);var s=e.children,o=e.sel;if("!"===o)isUndef(e.text)&&(e.text=""),e.elm=i.createComment(e.text);else if(void 0!==o){var p=o.indexOf("#"),c=o.indexOf(".",p),d=p>0?p:o.length,u=c>0?c:o.length,h=-1!==p||-1!==c?o.slice(0,Math.min(d,u)):o,f=e.elm=isDef(r)&&isDef(a=r.ns)?i.createElementNS(a,h):i.createElement(h);for(d<u&&f.setAttribute("id",o.slice(d+1,u)),c>0&&f.setAttribute("class",o.slice(u+1).replace(/\./g," ")),a=0;a<n.create.length;++a)n.create[a](emptyNode,e);if(array(s))for(a=0;a<s.length;++a){var v=s[a];null!=v&&i.appendChild(f,l(v,t))}else primitive(e.text)&&i.appendChild(f,i.createTextNode(e.text));isDef(a=e.data.hook)&&(a.create&&a.create(emptyNode,e),a.insert&&t.push(e))}else e.elm=i.createTextNode(e.text);return e.elm}function p(e,t,a,r,n,s){for(;r<=n;++r){var o=a[r];null!=o&&i.insertBefore(e,l(o,s),t)}}function c(e){var t,a,r=e.data;if(void 0!==r){for(isDef(t=r.hook)&&isDef(t=t.destroy)&&t(e),t=0;t<n.destroy.length;++t)n.destroy[t](e);if(void 0!==e.children)for(a=0;a<e.children.length;++a)null!=(t=e.children[a])&&"string"!=typeof t&&c(t)}}function d(e,t,a,r){for(;a<=r;++a){var s=void 0,l=void 0,p=void 0,d=t[a];if(null!=d)if(isDef(d.sel)){for(c(d),l=n.remove.length+1,p=o(d.elm,l),s=0;s<n.remove.length;++s)n.remove[s](d,p);isDef(s=d.data)&&isDef(s=s.hook)&&isDef(s=s.remove)?s(d,p):p()}else i.removeChild(e,d.elm)}}function u(e,t,a){var r,s;isDef(r=t.data)&&isDef(s=r.hook)&&isDef(r=s.prepatch)&&r(e,t);var o=t.elm=e.elm,c=e.children,h=t.children;if(e!==t){if(void 0!==t.data){for(r=0;r<n.update.length;++r)n.update[r](e,t);isDef(r=t.data.hook)&&isDef(r=r.update)&&r(e,t)}isUndef(t.text)?isDef(c)&&isDef(h)?c!==h&&function(e,t,a,r){for(var n,s,o,c=0,h=0,f=t.length-1,v=t[0],m=t[f],g=a.length-1,b=a[0],y=a[g];c<=f&&h<=g;)null==v?v=t[++c]:null==m?m=t[--f]:null==b?b=a[++h]:null==y?y=a[--g]:sameVnode(v,b)?(u(v,b,r),v=t[++c],b=a[++h]):sameVnode(m,y)?(u(m,y,r),m=t[--f],y=a[--g]):sameVnode(v,y)?(u(v,y,r),i.insertBefore(e,v.elm,i.nextSibling(m.elm)),v=t[++c],y=a[--g]):sameVnode(m,b)?(u(m,b,r),i.insertBefore(e,m.elm,v.elm),m=t[--f],b=a[++h]):(void 0===n&&(n=createKeyToOldIdx(t,c,f)),isUndef(s=n[b.key])?(i.insertBefore(e,l(b,r),v.elm),b=a[++h]):((o=t[s]).sel!==b.sel?i.insertBefore(e,l(b,r),v.elm):(u(o,b,r),t[s]=void 0,i.insertBefore(e,o.elm,v.elm)),b=a[++h]));(c<=f||h<=g)&&(c>f?p(e,null==a[g+1]?null:a[g+1].elm,a,h,g,r):d(e,t,c,f))}(o,c,h,a):isDef(h)?(isDef(e.text)&&i.setTextContent(o,""),p(o,null,h,0,h.length-1,a)):isDef(c)?d(o,c,0,c.length-1):isDef(e.text)&&i.setTextContent(o,""):e.text!==t.text&&i.setTextContent(o,t.text),isDef(s)&&isDef(r=s.postpatch)&&r(e,t)}}return function(e,t){var a,r,s,o=[];for(a=0;a<n.pre.length;++a)n.pre[a]();for(isVnode(e)||(e=function(e){var t=e.id?"#"+e.id:"",a=e.className?"."+e.className.split(" ").join("."):"";return vnode(i.tagName(e).toLowerCase()+t+a,{},[],void 0,e)}(e)),sameVnode(e,t)?u(e,t,o):(r=e.elm,s=i.parentNode(r),l(t,o),null!==s&&(i.insertBefore(s,t.elm,i.nextSibling(r)),d(s,[e],0,0))),a=0;a<o.length;++a)o[a].data.hook.insert(o[a]);for(a=0;a<n.post.length;++a)n.post[a]();return t}}var xlinkNS="http://www.w3.org/1999/xlink",xmlNS="http://www.w3.org/XML/1998/namespace",colonChar=58,xChar=120;function updateAttrs(e,t){var a,r=t.elm,n=e.data.attrs,i=t.data.attrs;if((n||i)&&n!==i){for(a in n=n||{},i=i||{}){var s=i[a];n[a]!==s&&(!0===s?r.setAttribute(a,""):!1===s?r.removeAttribute(a):a.charCodeAt(0)!==xChar?r.setAttribute(a,s):a.charCodeAt(3)===colonChar?r.setAttributeNS(xmlNS,a,s):a.charCodeAt(5)===colonChar?r.setAttributeNS(xlinkNS,a,s):r.setAttribute(a,s))}for(a in n)a in i||r.removeAttribute(a)}}var attributesModule={create:updateAttrs,update:updateAttrs};function updateProps(e,t){var a,r,n=t.elm,i=e.data.props,s=t.data.props;if((i||s)&&i!==s){for(a in s=s||{},i=i||{})s[a]||delete n[a];for(a in s)r=s[a],i[a]===r||"value"===a&&n[a]===r||(n[a]=r)}}var propsModule={create:updateProps,update:updateProps},raf="undefined"!=typeof window&&window.requestAnimationFrame||setTimeout,nextFrame=function(e){raf(function(){raf(e)})};function setNextFrame(e,t,a){nextFrame(function(){e[t]=a})}function updateStyle(e,t){var a,r,n=t.elm,i=e.data.style,s=t.data.style;if((i||s)&&i!==s){s=s||{};var o="delayed"in(i=i||{});for(r in i)s[r]||("-"===r[0]&&"-"===r[1]?n.style.removeProperty(r):n.style[r]="");for(r in s)if(a=s[r],"delayed"===r&&s.delayed)for(var l in s.delayed)a=s.delayed[l],o&&a===i.delayed[l]||setNextFrame(n.style,l,a);else"remove"!==r&&a!==i[r]&&("-"===r[0]&&"-"===r[1]?n.style.setProperty(r,a):n.style[r]=a)}}function applyDestroyStyle(e){var t,a,r=e.elm,n=e.data.style;if(n&&(t=n.destroy))for(a in t)r.style[a]=t[a]}function applyRemoveStyle(e,t){var a=e.data.style;if(a&&a.remove){var r,n=e.elm,i=0,s=a.remove,o=0,l=[];for(r in s)l.push(r),n.style[r]=s[r];for(var p=getComputedStyle(n)["transition-property"].split(", ");i<p.length;++i)-1!==l.indexOf(p[i])&&o++;n.addEventListener("transitionend",function(e){e.target===n&&--o,0===o&&t()})}else t()}var styleModule={create:updateStyle,update:updateStyle,destroy:applyDestroyStyle,remove:applyRemoveStyle};function invokeHandler(e,t,a){"function"==typeof e&&e.apply(void 0,[t].concat(a))}function handleEvent(e,t,a){var r=e.type,n=a.data.on;n&&n[r]&&invokeHandler(n[r],e,t,a)}function createListener(){return function e(t){for(var a=[],r=arguments.length-1;r-- >0;)a[r]=arguments[r+1];handleEvent(t,a,e.vnode)}}function updateEvents(e,t){var a=e.data.on,r=e.listener,n=e.elm,i=t&&t.data.on,s=t&&t.elm;if(a!==i&&(a&&r&&(i?Object.keys(a).forEach(function(e){i[e]||$(n).off(e,r)}):Object.keys(a).forEach(function(e){$(n).off(e,r)})),i)){var o=e.listener||createListener();t.listener=o,o.vnode=t,a?Object.keys(i).forEach(function(e){a[e]||$(s).on(e,o)}):Object.keys(i).forEach(function(e){$(s).on(e,o)})}}var eventListenersModule={create:updateEvents,update:updateEvents,destroy:updateEvents},patch=init$1([attributesModule,propsModule,styleModule,eventListenersModule]),Framework7Component=function(e,t,a){void 0===a&&(a={});var r=Utils.id(),n=Utils.merge(this,a,{$:$,$$:$,$dom7:$,$app:e,$f7:e,$options:Utils.extend({id:r},t)}),i=n.$options;Object.defineProperty(n,"$root",{enumerable:!0,configurable:!0,get:function(){var t=Utils.merge({},e.data,e.methods);return win&&win.Proxy&&(t=new win.Proxy(t,{set:function(t,a,r){e.data[a]=r},deleteProperty:function(t,a){delete e.data[a],delete e.methods[a]},has:function(t,a){return a in e.data||a in e.methods}})),t},set:function(){}}),"beforeCreate created beforeMount mounted beforeDestroy destroyed updated".split(" ").forEach(function(e){i[e]&&(i[e]=i[e].bind(n))}),i.data&&(i.data=i.data.bind(n),Utils.extend(n,i.data())),i.render&&(i.render=i.render.bind(n)),i.methods&&Object.keys(i.methods).forEach(function(e){n[e]=i.methods[e].bind(n)}),i.on&&Object.keys(i.on).forEach(function(e){i.on[e]=i.on[e].bind(n)}),i.once&&Object.keys(i.once).forEach(function(e){i.once[e]=i.once[e].bind(n)}),i.beforeCreate&&i.beforeCreate();var s=n.$render();return s&&"string"==typeof s?(s=s.trim(),n.$vnode=vdom(s,n,e,!0),n.el=doc.createElement("div"),patch(n.el,n.$vnode)):s&&(n.el=s),n.$el=$(n.el),i.style&&(n.$styleEl=doc.createElement("style"),n.$styleEl.innerHTML=i.style,i.styleScoped&&n.el.setAttribute("data-f7-"+i.id,"")),n.$attachEvents(),i.created&&i.created(),n.el.f7Component=n,n};function parseComponent(e){var t,a=Utils.id(),r="f7_component_create_callback_"+a,n="f7_component_render_callback_"+a,i=e.match(/<template([ ]?)([a-z0-9-]*)>/),s=i[2]||"t7";i&&(t=e.split(/<template[ ]?[a-z0-9-]*>/).filter(function(e,t){return t>0}).join("<template>").split("</template>").filter(function(e,t,a){return t<a.length-1}).join("</template>").replace(/{{#raw}}([ \n]*)<template/g,"{{#raw}}<template").replace(/\/template>([ \n]*){{\/raw}}/g,"/template>{{/raw}}").replace(/([ \n])<template/g,"$1{{#raw}}<template").replace(/\/template>([ \n])/g,"/template>{{/raw}}$1"));var o,l,p=null,c=!1;if(e.indexOf("<style>")>=0?p=e.split("<style>")[1].split("</style>")[0]:e.indexOf("<style scoped>")>=0&&(c=!0,p=(p=e.split("<style scoped>")[1].split("</style>")[0]).split("\n").map(function(e){return 0===e.trim().indexOf("@")?e:e.indexOf("{")>=0?e.indexOf("{{this}}")>=0?e.replace("{{this}}","[data-f7-"+a+"]"):"[data-f7-"+a+"] "+e.trim():e}).join("\n")),e.indexOf("<script>")>=0){var d=e.split("<script>");o=d[d.length-1].split("<\/script>")[0].trim()}else o="return {}";o&&o.trim()||(o="return {}"),o="window."+r+" = function () {"+o+"}",(l=doc.createElement("script")).innerHTML=o,$("head").append(l);var u=win[r]();if($(l).remove(),win[r]=null,delete win[r],u.template||u.render||(u.template=t,u.templateType=s),u.template&&("t7"===u.templateType&&(u.template=Template7.compile(u.template)),"es"===u.templateType)){var h="window."+n+" = function () {\n        return function render() {\n          return `"+u.template+"`;\n        }\n      }";(l=doc.createElement("script")).innerHTML=h,$("head").append(l),u.render=win[n](),$(l).remove(),win[n]=null,delete win[n]}return p&&(u.style=p,u.styleScoped=c),u.id=a,u}Framework7Component.prototype.$attachEvents=function(){var e=this.$options,t=this.$el;e.on&&Object.keys(e.on).forEach(function(a){t.on(Utils.eventNameToColonCase(a),e.on[a])}),e.once&&Object.keys(e.once).forEach(function(a){t.once(Utils.eventNameToColonCase(a),e.once[a])})},Framework7Component.prototype.$detachEvents=function(){var e=this.$options,t=this.$el;e.on&&Object.keys(e.on).forEach(function(a){t.off(Utils.eventNameToColonCase(a),e.on[a])}),e.once&&Object.keys(e.once).forEach(function(a){t.off(Utils.eventNameToColonCase(a),e.once[a])})},Framework7Component.prototype.$render=function(){var e=this.$options,t="";if(e.render)t=e.render();else if(e.template)if("string"==typeof e.template)try{t=Template7.compile(e.template)(this)}catch(e){throw e}else t=e.template(this);return t},Framework7Component.prototype.$forceUpdate=function(){var e=this.$render();if(e&&"string"==typeof e){var t=vdom(e=e.trim(),this,this.$app);this.$vnode=patch(this.$vnode,t)}},Framework7Component.prototype.$setState=function(e){Utils.merge(this,e),this.$forceUpdate()},Framework7Component.prototype.$mount=function(e){this.$options.beforeMount&&this.$options.beforeMount(),this.$styleEl&&$("head").append(this.$styleEl),e&&e(this.el),this.$options.mounted&&this.$options.mounted()},Framework7Component.prototype.$destroy=function(){this.$options.beforeDestroy&&this.$options.beforeDestroy(),this.$styleEl&&$(this.$styleEl).remove(),this.$detachEvents(),this.$options.destroyed&&this.$options.destroyed(),this.el&&this.el.f7Component&&(this.el.f7Component=null,delete this.el.f7Component),this.$vnode&&(this.$vnode=patch(this.$vnode,{sel:this.$vnode.sel,data:{}})),Utils.deleteProps(this)};var ComponentModule={name:"component",create:function(){var e=this;e.component={parse:function(e){return parseComponent(e)},create:function(t,a){return new Framework7Component(e,t,a)}}}},SW={registrations:[],register:function(e,t){var a=this;return"serviceWorker"in window.navigator&&a.serviceWorker.container?new Promise(function(r,n){a.serviceWorker.container.register(e,t?{scope:t}:{}).then(function(e){SW.registrations.push(e),a.emit("serviceWorkerRegisterSuccess",e),r(e)}).catch(function(e){a.emit("serviceWorkerRegisterError",e),n(e)})}):new Promise(function(e,t){t(new Error("Service worker is not supported"))})},unregister:function(e){var t,a=this;return"serviceWorker"in window.navigator&&a.serviceWorker.container?(t=e?Array.isArray(e)?e:[e]:SW.registrations,Promise.all(t.map(function(e){return new Promise(function(t,r){e.unregister().then(function(){SW.registrations.indexOf(e)>=0&&SW.registrations.splice(SW.registrations.indexOf(e),1),a.emit("serviceWorkerUnregisterSuccess",e),t()}).catch(function(t){a.emit("serviceWorkerUnregisterError",e,t),r(t)})})}))):new Promise(function(e,t){t(new Error("Service worker is not supported"))})}},ServiceWorkerModule={name:"sw",params:{serviceWorker:{path:void 0,scope:void 0}},create:function(){Utils.extend(this,{serviceWorker:{container:"serviceWorker"in window.navigator?window.navigator.serviceWorker:void 0,registrations:SW.registrations,register:SW.register.bind(this),unregister:SW.unregister.bind(this)}})},on:{init:function(){if("serviceWorker"in window.navigator){var e=this;if(e.serviceWorker.container){var t=e.params.serviceWorker.path,a=e.params.serviceWorker.scope;if(t&&(!Array.isArray(t)||t.length))(Array.isArray(t)?t:[t]).forEach(function(t){e.serviceWorker.register(t,a)})}}}}},Statusbar={hide:function(){$("html").removeClass("with-statusbar"),Device.cordova&&win.StatusBar&&win.StatusBar.hide()},show:function(){if(Device.cordova&&win.StatusBar)return win.StatusBar.show(),void Utils.nextTick(function(){Device.needsStatusbarOverlay()&&$("html").addClass("with-statusbar")});$("html").addClass("with-statusbar")},onClick:function(){var e;(e=$(".popup.modal-in").length>0?$(".popup.modal-in").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".panel.panel-active").length>0?$(".panel.panel-active").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".views > .view.tab-active").length>0?$(".views > .view.tab-active").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".views").length>0?$(".views").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):this.root.children(".view").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"))&&e.length>0&&(e.hasClass("tab")&&(e=e.parent(".tabs").children(".page-content.tab-active")),e.length>0&&e.scrollTop(0,300))},setTextColor:function(e){Device.cordova&&win.StatusBar&&("white"===e?win.StatusBar.styleLightContent():win.StatusBar.styleDefault())},setIosTextColor:function(e){Device.ios&&Statusbar.setTextColor(e)},setBackgroundColor:function(e){$(".statusbar").css("background-color",e),Device.cordova&&win.StatusBar&&win.StatusBar.backgroundColorByHexString(e)},isVisible:function(){return!(!Device.cordova||!win.StatusBar)&&win.StatusBar.isVisible},overlaysWebView:function(e){void 0===e&&(e=!0),Device.cordova&&win.StatusBar&&(win.StatusBar.overlaysWebView(e),e?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar"))},checkOverlay:function(){Device.needsStatusbarOverlay()?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar")},init:function(){var e=this.params.statusbar;e.enabled&&("auto"===e.overlay?(Device.needsStatusbarOverlay()?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar"),Device.ios&&(Device.cordova||Device.webView)&&(0===win.orientation&&this.once("resize",function(){Statusbar.checkOverlay()}),$(doc).on("resume",function(){Statusbar.checkOverlay()},!1),this.on(Device.ios?"orientationchange":"orientationchange resize",function(){Statusbar.checkOverlay()}))):!0===e.overlay?$("html").addClass("with-statusbar"):!1===e.overlay&&$("html").removeClass("with-statusbar"),Device.cordova&&win.StatusBar&&(e.scrollTopOnClick&&$(win).on("statusTap",Statusbar.onClick.bind(this)),Device.ios&&(e.iosOverlaysWebView?win.StatusBar.overlaysWebView(!0):win.StatusBar.overlaysWebView(!1),"white"===e.iosTextColor?win.StatusBar.styleLightContent():win.StatusBar.styleDefault()),Device.android&&(e.androidOverlaysWebView?win.StatusBar.overlaysWebView(!0):win.StatusBar.overlaysWebView(!1),"white"===e.androidTextColor?win.StatusBar.styleLightContent():win.StatusBar.styleDefault())),e.iosBackgroundColor&&Device.ios&&Statusbar.setBackgroundColor(e.iosBackgroundColor),(e.materialBackgroundColor||e.androidBackgroundColor)&&Device.android&&Statusbar.setBackgroundColor(e.materialBackgroundColor||e.androidBackgroundColor))}},Statusbar$1={name:"statusbar",params:{statusbar:{enabled:!0,overlay:"auto",scrollTopOnClick:!0,iosOverlaysWebView:!0,iosTextColor:"black",iosBackgroundColor:null,androidOverlaysWebView:!1,androidTextColor:"black",androidBackgroundColor:null}},create:function(){Utils.extend(this,{statusbar:{checkOverlay:Statusbar.checkOverlay,hide:Statusbar.hide,show:Statusbar.show,overlaysWebView:Statusbar.overlaysWebView,setTextColor:Statusbar.setTextColor,setBackgroundColor:Statusbar.setBackgroundColor,isVisible:Statusbar.isVisible,init:Statusbar.init.bind(this)}})},on:{init:function(){Statusbar.init.call(this)}},clicks:{".statusbar":function(){this.params.statusbar.enabled&&this.params.statusbar.scrollTopOnClick&&Statusbar.onClick.call(this)}}};function getCurrentView(e){var t=$(".popover.modal-in .view"),a=$(".popup.modal-in .view"),r=$(".panel.panel-active .view"),n=$(".views");0===n.length&&(n=e.root);var i=n.children(".view");if(i.length>1&&i.hasClass("tab")&&(i=n.children(".view.tab-active")),t.length>0&&t[0].f7View)return t[0].f7View;if(a.length>0&&a[0].f7View)return a[0].f7View;if(r.length>0&&r[0].f7View)return r[0].f7View;if(i.length>0){if(1===i.length&&i[0].f7View)return i[0].f7View;if(i.length>1)return e.views.main}}var View$1={name:"view",params:{view:{name:void 0,main:!1,router:!0,linksView:null,stackPages:!1,xhrCache:!0,xhrCacheIgnore:[],xhrCacheIgnoreGetParameters:!1,xhrCacheDuration:6e5,preloadPreviousPage:!0,allowDuplicateUrls:!1,reloadPages:!1,reloadDetail:!1,masterDetailBreakpoint:0,removeElements:!0,removeElementsWithTimeout:!1,removeElementsTimeout:0,restoreScrollTopOnBack:!0,unloadTabContent:!0,passRouteQueryToRequest:!0,passRouteParamsToRequest:!1,iosSwipeBack:!0,iosSwipeBackAnimateShadow:!0,iosSwipeBackAnimateOpacity:!0,iosSwipeBackActiveArea:30,iosSwipeBackThreshold:0,mdSwipeBack:!1,mdSwipeBackAnimateShadow:!0,mdSwipeBackAnimateOpacity:!1,mdSwipeBackActiveArea:30,mdSwipeBackThreshold:0,auroraSwipeBack:!1,auroraSwipeBackAnimateShadow:!1,auroraSwipeBackAnimateOpacity:!0,auroraSwipeBackActiveArea:30,auroraSwipeBackThreshold:0,pushState:!1,pushStateRoot:void 0,pushStateAnimate:!0,pushStateAnimateOnLoad:!1,pushStateSeparator:"#!",pushStateOnLoad:!0,animate:!0,iosDynamicNavbar:!0,iosSeparateDynamicNavbar:!0,iosAnimateNavbarBackIcon:!0,iosPageLoadDelay:0,mdPageLoadDelay:0,auroraPageLoadDelay:0,routesBeforeEnter:null,routesBeforeLeave:null}},static:{View:View},create:function(){var e=this;Utils.extend(e,{views:Utils.extend([],{create:function(t,a){return new View(e,t,a)},get:function(e){var t=$(e);if(t.length&&t[0].f7View)return t[0].f7View}})}),Object.defineProperty(e.views,"current",{enumerable:!0,configurable:!0,get:function(){return getCurrentView(e)}}),e.view=e.views},on:{init:function(){var e=this;$(".view-init").each(function(t,a){if(!a.f7View){var r=$(a).dataset();e.views.create(a,r)}})},modalOpen:function(e){var t=this;e.$el.find(".view-init").each(function(e,a){if(!a.f7View){var r=$(a).dataset();t.views.create(a,r)}})},modalBeforeDestroy:function(e){e&&e.$el&&e.$el.find(".view-init").each(function(e,t){var a=t.f7View;a&&a.destroy()})}}},Navbar={size:function(e){var t=this;if("ios"===t.theme||t.params.navbar[t.theme+"CenterTitle"]){var a=$(e);if(a.hasClass("navbar"))a=a.children(".navbar-inner").each(function(e,a){t.navbar.size(a)});else if(!(a.hasClass("stacked")||a.parents(".stacked").length>0||a.parents(".tab:not(.tab-active)").length>0||a.parents(".popup:not(.modal-in)").length>0)){"ios"!==t.theme&&t.params.navbar[t.theme+"CenterTitle"]&&a.addClass("navbar-inner-centered-title"),"ios"!==t.theme||t.params.navbar.iosCenterTitle||a.addClass("navbar-inner-left-title");var r,n,i,s,o=a.parents(".view").eq(0),l=t.rtl?a.children(".right"):a.children(".left"),p=t.rtl?a.children(".left"):a.children(".right"),c=a.children(".title"),d=a.children(".subnavbar"),u=0===l.length,h=0===p.length,f=u?0:l.outerWidth(!0),v=h?0:p.outerWidth(!0),m=c.outerWidth(!0),g=a.styles(),b=a[0].offsetWidth,y=b-parseInt(g.paddingLeft,10)-parseInt(g.paddingRight,10),w=a.hasClass("navbar-previous"),C=a.hasClass("sliding"),x=0,E=0;o.length>0&&o[0].f7View&&(n=(r=o[0].f7View.router)&&r.dynamicNavbar,r&&r.separateNavbar||(x=b,E=b/5)),h&&(i=y-m),u&&(i=0),u||h||(i=(y-v-m+f)/2);var k=(y-m)/2;y-f-v>m?(k<f&&(k=f),k+m>y-v&&(k=y-v-m),s=k-i):s=0;var S=t.rtl?-1:1;if(n&&"ios"===t.theme){if(c.hasClass("sliding")||c.length>0&&C){var T=-(i+s)*S+E,M=(y-i-s-m)*S-x;if(w&&r&&r.params.iosAnimateNavbarBackIcon){var P=a.parent().find(".navbar-current").children(".left.sliding").find(".back .icon ~ span");P.length>0&&(T+=P[0].offsetLeft)}c[0].f7NavbarLeftOffset=T,c[0].f7NavbarRightOffset=M}if(!u&&(l.hasClass("sliding")||C))if(t.rtl)l[0].f7NavbarLeftOffset=-(y-l[0].offsetWidth)/2*S,l[0].f7NavbarRightOffset=f*S;else if(l[0].f7NavbarLeftOffset=-f+E,l[0].f7NavbarRightOffset=(y-l[0].offsetWidth)/2-x,r&&r.params.iosAnimateNavbarBackIcon&&l.find(".back .icon").length>0&&l.find(".back .icon ~ span").length){var O=l[0].f7NavbarLeftOffset,D=l[0].f7NavbarRightOffset;l[0].f7NavbarLeftOffset=0,l[0].f7NavbarRightOffset=0,l.find(".back .icon ~ span")[0].f7NavbarLeftOffset=O,l.find(".back .icon ~ span")[0].f7NavbarRightOffset=D-l.find(".back .icon")[0].offsetWidth}h||!p.hasClass("sliding")&&!C||(t.rtl?(p[0].f7NavbarLeftOffset=-v*S,p[0].f7NavbarRightOffset=(y-p[0].offsetWidth)/2*S):(p[0].f7NavbarLeftOffset=-(y-p[0].offsetWidth)/2+E,p[0].f7NavbarRightOffset=v-x)),d.length&&(d.hasClass("sliding")||C)&&(d[0].f7NavbarLeftOffset=t.rtl?d[0].offsetWidth:-d[0].offsetWidth+E,d[0].f7NavbarRightOffset=-d[0].f7NavbarLeftOffset-x+E)}if(t.params.navbar[t.theme+"CenterTitle"]){var I=s;t.rtl&&u&&h&&c.length>0&&(I=-I),c.css({left:I+"px"})}}}},hide:function(e,t){void 0===t&&(t=!0);var a=$(e);if(a.hasClass("navbar-inner")&&(a=a.parents(".navbar")),a.length&&!a.hasClass("navbar-hidden")){var r="navbar-hidden"+(t?" navbar-transitioning":"");("ios"===this.theme?a.find(".navbar-current .title-large").length:a.find(".title-large").length)&&(r+=" navbar-large-hidden"),a.transitionEnd(function(){a.removeClass("navbar-transitioning")}),a.addClass(r)}},show:function(e,t){void 0===e&&(e=".navbar-hidden"),void 0===t&&(t=!0);var a=$(e);a.hasClass("navbar-inner")&&(a=a.parents(".navbar")),a.length&&a.hasClass("navbar-hidden")&&(t&&(a.addClass("navbar-transitioning"),a.transitionEnd(function(){a.removeClass("navbar-transitioning")})),a.removeClass("navbar-hidden navbar-large-hidden"))},getElByPage:function(e){var t,a,r;if(e.$navbarEl||e.$el?(r=e,t=e.$el):(t=$(e)).length>0&&(r=t[0].f7Page),r&&r.$navbarEl&&r.$navbarEl.length>0?a=r.$navbarEl:t&&(a=t.children(".navbar").children(".navbar-inner")),a&&(!a||0!==a.length))return a[0]},getPageByEl:function(e){var t,a=$(e);if(!(a.hasClass("navbar")&&(a=a.find(".navbar-inner")).length>1))return a.parents(".page").length?a.parents(".page")[0]:(a.parents(".view").find(".page").each(function(e,r){r&&r.f7Page&&r.f7Page.navbarEl&&a[0]===r.f7Page.navbarEl&&(t=r)}),t)},collapseLargeTitle:function(e){var t=$(e);if(!(t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length))){var a=$(this.navbar.getPageByEl(t));t.addClass("navbar-inner-large-collapsed"),a.eq(0).addClass("page-with-navbar-large-collapsed").trigger("page:navbarlargecollapsed"),"md"!==this.theme&&"aurora"!==this.theme||t.parents(".navbar").addClass("navbar-large-collapsed")}},expandLargeTitle:function(e){var t=$(e);if(!(t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length))){var a=$(this.navbar.getPageByEl(t));t.removeClass("navbar-inner-large-collapsed"),a.eq(0).removeClass("page-with-navbar-large-collapsed").trigger("page:navbarlargeexpanded"),"md"!==this.theme&&"aurora"!==this.theme||t.parents(".navbar").removeClass("navbar-large-collapsed")}},toggleLargeTitle:function(e){var t=$(e);t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length)||(t.hasClass("navbar-inner-large-collapsed")?this.navbar.expandLargeTitle(t):this.navbar.collapseLargeTitle(t))},initNavbarOnScroll:function(e,t,a,r){var n,i,s,o,l,p,c,d,u,h,f,v,m,g=this,b=$(e),y=$(t),w="md"===g.theme||"aurora"===g.theme?y.parents(".navbar"):$(t||g.navbar.getElByPage(e)).closest(".navbar"),C=y.find(".title-large").length||y.hasClass(".navbar-inner-large"),x=44,E=g.params.navbar.snapPageScrollToLargeTitle;(r||a&&C)&&((u=y.css("--f7-navbar-large-title-height"))&&u.indexOf("px")>=0?(u=parseInt(u,10),Number.isNaN(u)&&("ios"===g.theme?u=52:"md"===g.theme?u=48:"aurora"===g.theme&&(u=38))):"ios"===g.theme?u=52:"md"===g.theme?u=48:"aurora"===g.theme&&(u=38)),a&&C&&(x+=u);var k=70,S=300;function T(){y.hasClass("with-searchbar-expandable-enabled")||!f||i<0||(i>=u/2&&i<u?$(f).scrollTop(u,100):i<u&&$(f).scrollTop(0,200))}function M(){var e;i=(f=this).scrollTop,h=i,r&&(e=Math.min(Math.max(i/u,0),1),y.hasClass("with-searchbar-expandable-enabled")||(d=y.hasClass("navbar-inner-large-collapsed"),0===e&&d?(g.navbar.expandLargeTitle(y[0]),y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="","md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")):1!==e||d?1===e&&d||0===e&&!d?(y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="",b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")):(y[0].style.setProperty("--f7-navbar-large-collapse-progress",e),y[0].style.overflow="visible",b[0].style.setProperty("--f7-navbar-large-collapse-progress",e),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.setProperty("--f7-navbar-large-collapse-progress",e)):(g.navbar.collapseLargeTitle(y[0]),y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="",b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")),E&&(Support.touch?m&&(clearTimeout(m),m=null,m=setTimeout(function(){T(),clearTimeout(m),m=null},k)):(clearTimeout(v),v=setTimeout(function(){T()},S))))),b.hasClass("page-previous")||a&&(s=f.scrollHeight,o=f.offsetHeight,l=i+o>=s,c=w.hasClass("navbar-hidden"),l?g.params.navbar.showOnPageScrollEnd&&(p="show"):p=n>i?g.params.navbar.showOnPageScrollTop||i<=x?"show":"hide":i>x?"hide":"show","show"===p&&c?(g.navbar.show(w),c=!1):"hide"!==p||c||(g.navbar.hide(w),c=!0),n=i)}function P(){h=!1}function O(){clearTimeout(m),m=null,m=setTimeout(function(){!1!==h&&(T(),clearTimeout(m),m=null)},k)}b.on("scroll",".page-content",M,!0),Support.touch&&r&&E&&(g.on("touchstart:passive",P),g.on("touchend:passive",O)),r&&b.find(".page-content").each(function(e,t){t.scrollTop>0&&M.call(t)}),b[0].f7DetachNavbarScrollHandlers=function(){delete b[0].f7DetachNavbarScrollHandlers,b.off("scroll",".page-content",M,!0),Support.touch&&r&&E&&(g.off("touchstart:passive",P),g.off("touchend:passive",O))}}},Navbar$1={name:"navbar",create:function(){var e=this;Utils.extend(e,{navbar:{size:Navbar.size.bind(e),hide:Navbar.hide.bind(e),show:Navbar.show.bind(e),getElByPage:Navbar.getElByPage.bind(e),getPageByEl:Navbar.getPageByEl.bind(e),collapseLargeTitle:Navbar.collapseLargeTitle.bind(e),expandLargeTitle:Navbar.expandLargeTitle.bind(e),toggleLargeTitle:Navbar.toggleLargeTitle.bind(e),initNavbarOnScroll:Navbar.initNavbarOnScroll.bind(e)}})},params:{navbar:{scrollTopOnTitleClick:!0,iosCenterTitle:!0,mdCenterTitle:!1,auroraCenterTitle:!0,hideOnPageScroll:!1,showOnPageScrollEnd:!0,showOnPageScrollTop:!0,collapseLargeTitleOnScroll:!0,snapPageScrollToLargeTitle:!0}},on:{"panelBreakpoint resize viewMasterDetailBreakpoint":function(){var e=this;$(".navbar").each(function(t,a){e.navbar.size(a)})},pageBeforeRemove:function(e){e.$el[0].f7DetachNavbarScrollHandlers&&e.$el[0].f7DetachNavbarScrollHandlers()},pageBeforeIn:function(e){if("ios"===this.theme){var t,a=e.$el.parents(".view")[0].f7View,r=this.navbar.getElByPage(e);if(t=r?$(r).parents(".navbar"):e.$el.parents(".view").children(".navbar"),e.$el.hasClass("no-navbar")||a.router.dynamicNavbar&&!r){var n=!!(e.pageFrom&&e.router.history.length>0);this.navbar.hide(t,n)}else this.navbar.show(t)}},pageReinit:function(e){var t=$(this.navbar.getElByPage(e));t&&0!==t.length&&this.navbar.size(t)},pageInit:function(e){var t,a,r=$(this.navbar.getElByPage(e));r&&0!==r.length&&(this.navbar.size(r),r.children(".title-large").length>0&&r.addClass("navbar-inner-large"),r.hasClass("navbar-inner-large")&&(this.params.navbar.collapseLargeTitleOnScroll&&(t=!0),"md"!==this.theme&&"aurora"!==this.theme||r.parents(".navbar").addClass("navbar-large"),e.$el.addClass("page-with-navbar-large")),(this.params.navbar.hideOnPageScroll||e.$el.find(".hide-navbar-on-scroll").length||e.$el.hasClass("hide-navbar-on-scroll")||e.$el.find(".hide-bars-on-scroll").length||e.$el.hasClass("hide-bars-on-scroll"))&&(a=!(e.$el.find(".keep-navbar-on-scroll").length||e.$el.hasClass("keep-navbar-on-scroll")||e.$el.find(".keep-bars-on-scroll").length||e.$el.hasClass("keep-bars-on-scroll"))),(t||a)&&this.navbar.initNavbarOnScroll(e.el,r[0],a,t))},modalOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},panelOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},panelSwipeOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},tabShow:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&$(e).find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})}},clicks:{".navbar .title":function(e){if(this.params.navbar.scrollTopOnTitleClick&&!(e.closest("a").length>0)){var t,a=e.parents(".navbar");0===(t=a.parents(".page-content")).length&&(a.parents(".page").length>0&&(t=a.parents(".page").find(".page-content")),0===t.length&&a.nextAll(".page-current:not(.stacked)").length>0&&(t=a.nextAll(".page-current:not(.stacked)").find(".page-content"))),t&&t.length>0&&(t.hasClass("tab")&&(t=t.parent(".tabs").children(".page-content.tab-active")),t.length>0&&t.scrollTop(0,300))}}},vnode:{"navbar-inner":{postpatch:function(e){this.params.navbar[this.theme+"CenterTitle"]&&this.navbar.size(e.elm)}}}},Toolbar={setHighlight:function(e){if("md"===this.theme){var t=$(e);if(0!==t.length&&(t.hasClass("tabbar")||t.hasClass("tabbar-labels"))){var a=t.find(".tab-link-highlight"),r=t.find(".tab-link").length;if(0!==r){0===a.length?(t.children(".toolbar-inner").append('<span class="tab-link-highlight"></span>'),a=t.find(".tab-link-highlight")):a.next().length&&t.children(".toolbar-inner").append(a);var n,i,s=t.find(".tab-link-active");if(t.hasClass("tabbar-scrollable")&&s&&s[0])n=s[0].offsetWidth+"px",i=s[0].offsetLeft+"px";else{var o=s.index();n=100/r+"%",i=100*(this.rtl?-o:o)+"%"}Utils.nextFrame(function(){a.css("width",n).transform("translate3d("+i+",0,0)")})}else a.remove()}}},init:function(e){this.toolbar.setHighlight(e)},hide:function(e,t){void 0===t&&(t=!0);var a=$(e);if(!a.hasClass("toolbar-hidden")){var r="toolbar-hidden"+(t?" toolbar-transitioning":"");a.transitionEnd(function(){a.removeClass("toolbar-transitioning")}),a.addClass(r)}},show:function(e,t){void 0===t&&(t=!0);var a=$(e);a.hasClass("toolbar-hidden")&&(t&&(a.addClass("toolbar-transitioning"),a.transitionEnd(function(){a.removeClass("toolbar-transitioning")})),a.removeClass("toolbar-hidden"))},initHideToolbarOnScroll:function(e){var t,a,r,n,i,s,o,l=this,p=$(e),c=p.parents(".view").children(".toolbar");(0===c.length&&(c=p.find(".toolbar")),0===c.length&&(c=p.parents(".views").children(".tabbar, .tabbar-labels")),0!==c.length)&&(p.on("scroll",".page-content",d,!0),p[0].f7ScrollToolbarHandler=d);function d(){p.hasClass("page-previous")||(a=this.scrollTop,r=this.scrollHeight,n=this.offsetHeight,i=a+n>=r,o=c.hasClass("toolbar-hidden"),i?l.params.toolbar.showOnPageScrollEnd&&(s="show"):s=t>a?l.params.toolbar.showOnPageScrollTop||a<=44?"show":"hide":a>44?"hide":"show","show"===s&&o?(l.toolbar.show(c),o=!1):"hide"!==s||o||(l.toolbar.hide(c),o=!0),t=a)}}},Toolbar$1={name:"toolbar",create:function(){Utils.extend(this,{toolbar:{hide:Toolbar.hide.bind(this),show:Toolbar.show.bind(this),setHighlight:Toolbar.setHighlight.bind(this),initHideToolbarOnScroll:Toolbar.initHideToolbarOnScroll.bind(this),init:Toolbar.init.bind(this)}})},params:{toolbar:{hideOnPageScroll:!1,showOnPageScrollEnd:!0,showOnPageScrollTop:!0}},on:{pageBeforeRemove:function(e){e.$el[0].f7ScrollToolbarHandler&&e.$el.off("scroll",".page-content",e.$el[0].f7ScrollToolbarHandler,!0)},pageBeforeIn:function(e){var t=e.$el.parents(".view").children(".toolbar");0===t.length&&(t=e.$el.parents(".views").children(".tabbar, .tabbar-labels")),0===t.length&&(t=e.$el.find(".toolbar")),0!==t.length&&(e.$el.hasClass("no-toolbar")?this.toolbar.hide(t):this.toolbar.show(t))},pageInit:function(e){var t=this;if(e.$el.find(".tabbar, .tabbar-labels").each(function(e,a){t.toolbar.init(a)}),t.params.toolbar.hideOnPageScroll||e.$el.find(".hide-toolbar-on-scroll").length||e.$el.hasClass("hide-toolbar-on-scroll")||e.$el.find(".hide-bars-on-scroll").length||e.$el.hasClass("hide-bars-on-scroll")){if(e.$el.find(".keep-toolbar-on-scroll").length||e.$el.hasClass("keep-toolbar-on-scroll")||e.$el.find(".keep-bars-on-scroll").length||e.$el.hasClass("keep-bars-on-scroll"))return;t.toolbar.initHideToolbarOnScroll(e.el)}},init:function(){var e=this;e.root.find(".tabbar, .tabbar-labels").each(function(t,a){e.toolbar.init(a)})}}},Subnavbar={name:"subnavbar",on:{pageInit:function(e){e.$navbarEl&&e.$navbarEl.length&&e.$navbarEl.find(".subnavbar").length&&e.$el.addClass("page-with-subnavbar"),e.$el.find(".subnavbar").length&&e.$el.addClass("page-with-subnavbar")}}},TouchRipple=function(e,t,a){var r=this;if(e){var n=e[0].getBoundingClientRect(),i=t-n.left,s=a-n.top,o=n.width,l=n.height,p=Math.max(Math.pow(Math.pow(l,2)+Math.pow(o,2),.5),48);return r.$rippleWaveEl=$('<div class="ripple-wave" style="width: '+p+"px; height: "+p+"px; margin-top:-"+p/2+"px; margin-left:-"+p/2+"px; left:"+i+"px; top:"+s+'px;"></div>'),e.prepend(r.$rippleWaveEl),r.rippleTransform="translate3d("+(o/2-i)+"px, "+(l/2-s)+"px, 0) scale(1)",Utils.nextFrame(function(){r&&r.$rippleWaveEl&&r.$rippleWaveEl.transform(r.rippleTransform)}),r}};TouchRipple.prototype.onRemove=function(){var e=this;e.$rippleWaveEl&&e.$rippleWaveEl.remove(),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},TouchRipple.prototype.remove=function(){var e=this;if(!e.removing){var t=this.$rippleWaveEl,a=this.rippleTransform,r=Utils.nextTick(function(){e.onRemove()},400);e.removing=!0,t.addClass("ripple-wave-fill").transform(a.replace("scale(1)","scale(1.01)")).transitionEnd(function(){clearTimeout(r),Utils.nextFrame(function(){t.addClass("ripple-wave-out").transform(a.replace("scale(1)","scale(1.01)")),r=Utils.nextTick(function(){e.onRemove()},700),t.transitionEnd(function(){clearTimeout(r),e.onRemove()})})})}};var TouchRipple$1={name:"touch-ripple",static:{TouchRipple:TouchRipple},create:function(){this.touchRipple={create:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return new(Function.prototype.bind.apply(TouchRipple,[null].concat(e)))}}}},openedModals=[],dialogsQueue=[];function clearDialogsQueue(){0!==dialogsQueue.length&&dialogsQueue.shift().open()}var Modal=function(e){function t(t,a){e.call(this,a,[t]);var r={};return this.useModulesParams(r),this.params=Utils.extend(r,a),this.opened=!1,this.useModules(),this}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.onOpen=function(){this.opened=!0,openedModals.push(this),$("html").addClass("with-modal-"+this.type.toLowerCase()),this.$el.trigger("modal:open "+this.type.toLowerCase()+":open",this),this.emit("local::open modalOpen "+this.type+"Open",this)},t.prototype.onOpened=function(){this.$el.trigger("modal:opened "+this.type.toLowerCase()+":opened",this),this.emit("local::opened modalOpened "+this.type+"Opened",this)},t.prototype.onClose=function(){this.opened=!1,this.type&&this.$el&&(openedModals.splice(openedModals.indexOf(this),1),$("html").removeClass("with-modal-"+this.type.toLowerCase()),this.$el.trigger("modal:close "+this.type.toLowerCase()+":close",this),this.emit("local::close modalClose "+this.type+"Close",this))},t.prototype.onClosed=function(){this.type&&this.$el&&(this.$el.removeClass("modal-out"),this.$el.hide(),this.$el.trigger("modal:closed "+this.type.toLowerCase()+":closed",this),this.emit("local::closed modalClosed "+this.type+"Closed",this))},t.prototype.open=function(e){var t,a=this,r=a.app,n=a.$el,i=a.$backdropEl,s=a.type,o=!0;if(void 0!==e?o=e:void 0!==a.params.animate&&(o=a.params.animate),!n||n.hasClass("modal-in"))return a;if("dialog"===s&&r.params.modal.queueDialogs&&($(".dialog.modal-in").length>0?t=!0:openedModals.length>0&&openedModals.forEach(function(e){"dialog"===e.type&&(t=!0)}),t))return dialogsQueue.push(a),a;var l=n.parent(),p=n.parents(doc).length>0;function c(){n.hasClass("modal-out")?a.onClosed():n.hasClass("modal-in")&&a.onOpened()}return r.params.modal.moveToRoot&&!l.is(r.root)&&(r.root.append(n),a.once(s+"Closed",function(){p?l.append(n):n.remove()})),n.show(),a._clientLeft=n[0].clientLeft,o?(i&&(i.removeClass("not-animated"),i.addClass("backdrop-in")),n.animationEnd(function(){c()}),n.transitionEnd(function(){c()}),n.removeClass("modal-out not-animated").addClass("modal-in"),a.onOpen()):(i&&i.addClass("backdrop-in not-animated"),n.removeClass("modal-out").addClass("modal-in not-animated"),a.onOpen(),a.onOpened()),a},t.prototype.close=function(e){var t=this,a=t.$el,r=t.$backdropEl,n=!0;if(void 0!==e?n=e:void 0!==t.params.animate&&(n=t.params.animate),!a||!a.hasClass("modal-in"))return t;if(r){var i=!0;"popup"===t.type&&t.$el.prevAll(".popup.modal-in").each(function(e,a){var r=a.f7Modal;r&&r.params.closeByBackdropClick&&r.params.backdrop&&r.backdropEl===t.backdropEl&&(i=!1)}),i&&(r[n?"removeClass":"addClass"]("not-animated"),r.removeClass("backdrop-in"))}function s(){a.hasClass("modal-out")?t.onClosed():a.hasClass("modal-in")&&t.onOpened()}return a[n?"removeClass":"addClass"]("not-animated"),n?(a.animationEnd(function(){s()}),a.transitionEnd(function(){s()}),a.removeClass("modal-in").addClass("modal-out"),t.onClose()):(a.addClass("not-animated").removeClass("modal-in").addClass("modal-out"),t.onClose(),t.onClosed()),"dialog"===t.type&&clearDialogsQueue(),t},t.prototype.destroy=function(){this.destroyed||(this.emit("local::beforeDestroy modalBeforeDestroy "+this.type+"BeforeDestroy",this),this.$el&&(this.$el.trigger("modal:beforedestroy "+this.type.toLowerCase()+":beforedestroy",this),this.$el.length&&this.$el[0].f7Modal&&delete this.$el[0].f7Modal),Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),CustomModal=function(e){function t(t,a){var r=Utils.extend({backdrop:!0,closeByBackdropClick:!0,on:{}},a);e.call(this,t,r);var n,i,s=this;if(s.params=r,(n=s.params.el?$(s.params.el):$(s.params.content))&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(0===n.length)return s.destroy();function o(e){s&&!s.destroyed&&i&&e.target===i[0]&&s.close()}return s.params.backdrop&&0===(i=t.root.children(".custom-modal-backdrop")).length&&(i=$('<div class="custom-modal-backdrop"></div>'),t.root.append(i)),s.on("customModalOpened",function(){s.params.closeByBackdropClick&&s.params.backdrop&&t.on("click",o)}),s.on("customModalClose",function(){s.params.closeByBackdropClick&&s.params.backdrop&&t.off("click",o)}),Utils.extend(s,{app:t,$el:n,el:n[0],$backdropEl:i,backdropEl:i&&i[0],type:"customModal"}),n[0].f7Modal=s,s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Modal$1={name:"modal",static:{Modal:Modal,CustomModal:CustomModal},create:function(){var e=this;e.customModal={create:function(t){return new CustomModal(e,t)}}},params:{modal:{moveToRoot:!0,queueDialogs:!0}}},Appbar={name:"appbar"},Dialog=function(e){function t(t,a){var r=Utils.extend({title:t.params.dialog.title,text:void 0,content:"",buttons:[],verticalButtons:!1,onClick:void 0,cssClass:void 0,destroyOnClose:!1,on:{}},a);void 0===r.closeByBackdropClick&&(r.closeByBackdropClick=t.params.dialog.closeByBackdropClick),e.call(this,t,r);var n,i=this,s=r.title,o=r.text,l=r.content,p=r.buttons,c=r.verticalButtons,d=r.cssClass;if(i.params=r,i.params.el)n=$(i.params.el);else{var u=["dialog"];0===p.length&&u.push("dialog-no-buttons"),p.length>0&&u.push("dialog-buttons-"+p.length),c&&u.push("dialog-buttons-vertical"),d&&u.push(d);var h="";p.length>0&&(h='\n          <div class="dialog-buttons">\n            '+p.map(function(e){return'\n              <span class="dialog-button'+(e.bold?" dialog-button-bold":"")+(e.color?" color-"+e.color:"")+(e.cssClass?" "+e.cssClass:"")+'">'+e.text+"</span>\n            "}).join("")+"\n          </div>\n        ");var f='\n        <div class="'+u.join(" ")+'">\n          <div class="dialog-inner">\n            '+(s?'<div class="dialog-title">'+s+"</div>":"")+"\n            "+(o?'<div class="dialog-text">'+o+"</div>":"")+"\n            "+l+"\n          </div>\n          "+h+"\n        </div>\n      ";n=$(f)}if(n&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(0===n.length)return i.destroy();var v,m=t.root.children(".dialog-backdrop");function g(e){var t=$(this).index(),a=p[t];a.onClick&&a.onClick(i,e),i.params.onClick&&i.params.onClick(i,t),!1!==a.close&&i.close()}function b(e){var t=e.keyCode;p.forEach(function(a,r){a.keyCodes&&a.keyCodes.indexOf(t)>=0&&(doc.activeElement&&doc.activeElement.blur(),a.onClick&&a.onClick(i,e),i.params.onClick&&i.params.onClick(i,r),!1!==a.close&&i.close())})}function y(e){var t=e.target;0===$(t).closest(i.el).length&&i.params.closeByBackdropClick&&i.backdropEl&&i.backdropEl===t&&i.close()}return 0===m.length&&(m=$('<div class="dialog-backdrop"></div>'),t.root.append(m)),p&&p.length>0&&(i.on("open",function(){n.find(".dialog-button").each(function(e,t){p[e].keyCodes&&(v=!0),$(t).on("click",g)}),!v||t.device.ios||t.device.android||t.device.cordova||$(doc).on("keydown",b)}),i.on("close",function(){n.find(".dialog-button").each(function(e,t){$(t).off("click",g)}),!v||t.device.ios||t.device.android||t.device.cordova||$(doc).off("keydown",b),v=!1})),Utils.extend(i,{app:t,$el:n,el:n[0],$backdropEl:m,backdropEl:m[0],type:"dialog",setProgress:function(e,a){return t.progressbar.set(n.find(".progressbar"),e,a),i},setText:function(e){var t=n.find(".dialog-text");return 0===t.length&&(t=$('<div class="dialog-text"></div>'),void 0!==s?t.insertAfter(n.find(".dialog-title")):n.find(".dialog-inner").prepend(t)),t.html(e),i.params.text=e,i},setTitle:function(e){var t=n.find(".dialog-title");return 0===t.length&&(t=$('<div class="dialog-title"></div>'),n.find(".dialog-inner").prepend(t)),t.html(e),i.params.title=e,i}}),i.on("opened",function(){i.params.closeByBackdropClick&&t.on("click",y)}),i.on("close",function(){i.params.closeByBackdropClick&&t.off("click",y)}),n[0].f7Modal=i,i.params.destroyOnClose&&i.once("closed",function(){setTimeout(function(){i.destroy()},0)}),i}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Dialog$1={name:"dialog",params:{dialog:{title:void 0,buttonOk:"OK",buttonCancel:"Cancel",usernamePlaceholder:"Username",passwordPlaceholder:"Password",preloaderTitle:"Loading... ",progressTitle:"Loading... ",closeByBackdropClick:!1,destroyPredefinedDialogs:!0,keyboardActions:!0}},static:{Dialog:Dialog},create:function(){var e=this;function t(){return e.params.dialog.title||e.name}var a=e.params.dialog.destroyPredefinedDialogs,r=e.params.dialog.keyboardActions;e.dialog=Utils.extend(ModalMethods({app:e,constructor:Dialog,defaultSelector:".dialog.modal-in"}),{alert:function(){for(var n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2];return 2===i.length&&"function"==typeof i[1]&&(o=(n=i)[0],p=n[1],l=n[2]),new Dialog(e,{title:void 0===l?t():l,text:o,buttons:[{text:e.params.dialog.buttonOk,bold:!0,onClick:p,keyCodes:r?[13,27]:null}],destroyOnClose:a}).open()},prompt:function(){for(var n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2],c=i[3],d=i[4];return"function"==typeof i[1]&&(o=(n=i)[0],p=n[1],c=n[2],d=n[3],l=n[4]),d=null==d?"":d,new Dialog(e,{title:void 0===l?t():l,text:o,content:'<div class="dialog-input-field input"><input type="text" class="dialog-input" value="'+d+'"></div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find(".dialog-input").val();0===t&&c&&c(a),1===t&&p&&p(a)},destroyOnClose:a}).open()},confirm:function(){for(var n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2],c=i[3];return"function"==typeof i[1]&&(o=(n=i)[0],p=n[1],c=n[2],l=n[3]),new Dialog(e,{title:void 0===l?t():l,text:o,buttons:[{text:e.params.dialog.buttonCancel,onClick:c,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,onClick:p,keyCodes:r?[13]:null}],destroyOnClose:a}).open()},login:function(){for(var n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2],c=i[3];return"function"==typeof i[1]&&(o=(n=i)[0],p=n[1],c=n[2],l=n[3]),new Dialog(e,{title:void 0===l?t():l,text:o,content:'\n              <div class="dialog-input-field dialog-input-double input">\n                <input type="text" name="dialog-username" placeholder="'+e.params.dialog.usernamePlaceholder+'" class="dialog-input">\n              </div>\n              <div class="dialog-input-field dialog-input-double input">\n                <input type="password" name="dialog-password" placeholder="'+e.params.dialog.passwordPlaceholder+'" class="dialog-input">\n              </div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find('[name="dialog-username"]').val(),r=e.$el.find('[name="dialog-password"]').val();0===t&&c&&c(a,r),1===t&&p&&p(a,r)},destroyOnClose:a}).open()},password:function(){for(var n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2],c=i[3];return"function"==typeof i[1]&&(o=(n=i)[0],p=n[1],c=n[2],l=n[3]),new Dialog(e,{title:void 0===l?t():l,text:o,content:'\n              <div class="dialog-input-field input">\n                <input type="password" name="dialog-password" placeholder="'+e.params.dialog.passwordPlaceholder+'" class="dialog-input">\n              </div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find('[name="dialog-password"]').val();0===t&&c&&c(a),1===t&&p&&p(a)},destroyOnClose:a}).open()},preloader:function(t,r){var n=Utils[e.theme+"PreloaderContent"]||"";return new Dialog(e,{title:null==t?e.params.dialog.preloaderTitle:t,content:'<div class="preloader'+(r?" color-"+r:"")+'">'+n+"</div>",cssClass:"dialog-preloader",destroyOnClose:a}).open()},progress:function(){for(var t,r,n,i=[],s=arguments.length;s--;)i[s]=arguments[s];var o=i[0],l=i[1],p=i[2];2===i.length?"number"==typeof i[0]?(l=(t=i)[0],p=t[1],o=t[2]):"string"==typeof i[0]&&"string"==typeof i[1]&&(o=(r=i)[0],p=r[1],l=r[2]):1===i.length&&"number"==typeof i[0]&&(l=(n=i)[0],o=n[1],p=n[2]);var c=void 0===l,d=new Dialog(e,{title:void 0===o?e.params.dialog.progressTitle:o,cssClass:"dialog-progress",content:'\n              <div class="progressbar'+(c?"-infinite":"")+(p?" color-"+p:"")+'">\n                '+(c?"":"<span></span>")+"\n              </div>\n            ",destroyOnClose:a});return c||d.setProgress(l),d.open()}})}},Popup=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.popup,a);e.call(this,t,r);var n,i,s=this;if(s.params=r,(n=s.params.el?$(s.params.el):$(s.params.content))&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(0===n.length)return s.destroy();function o(e){var t=e.target;if(0===$(t).closest(s.el).length&&s.params&&s.params.closeByBackdropClick&&s.params.backdrop&&s.backdropEl&&s.backdropEl===t){var a=!0;s.$el.nextAll(".popup.modal-in").each(function(e,t){var r=t.f7Modal;r&&r.params.closeByBackdropClick&&r.params.backdrop&&r.backdropEl===s.backdropEl&&(a=!1)}),a&&s.close()}}return s.params.backdrop&&0===(i=t.root.children(".popup-backdrop")).length&&(i=$('<div class="popup-backdrop"></div>'),t.root.append(i)),Utils.extend(s,{app:t,$el:n,el:n[0],$backdropEl:i,backdropEl:i&&i[0],type:"popup"}),s.on("popupOpened",function(){s.params.closeByBackdropClick&&t.on("click",o)}),s.on("popupClose",function(){s.params.closeByBackdropClick&&t.off("click",o)}),n[0].f7Modal=s,s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Popup$1={name:"popup",params:{popup:{backdrop:!0,closeByBackdropClick:!0}},static:{Popup:Popup},create:function(){this.popup=ModalMethods({app:this,constructor:Popup,defaultSelector:".popup.modal-in"})},clicks:{".popup-open":function(e,t){void 0===t&&(t={});this.popup.open(t.popup,t.animate)},".popup-close":function(e,t){void 0===t&&(t={});this.popup.close(t.popup,t.animate)}}},LoginScreen=function(e){function t(t,a){var r=Utils.extend({on:{}},a);e.call(this,t,r);var n;return this.params=r,(n=this.params.el?$(this.params.el):$(this.params.content))&&n.length>0&&n[0].f7Modal?n[0].f7Modal:0===n.length?this.destroy():(Utils.extend(this,{app:t,$el:n,el:n[0],type:"loginScreen"}),n[0].f7Modal=this,this)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),LoginScreen$1={name:"loginScreen",static:{LoginScreen:LoginScreen},create:function(){this.loginScreen=ModalMethods({app:this,constructor:LoginScreen,defaultSelector:".login-screen.modal-in"})},clicks:{".login-screen-open":function(e,t){void 0===t&&(t={});this.loginScreen.open(t.loginScreen,t.animate)},".login-screen-close":function(e,t){void 0===t&&(t={});this.loginScreen.close(t.loginScreen,t.animate)}}},Popover=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.popover,a);e.call(this,t,r);var n,i=this;if(i.params=r,(n=i.params.el?$(i.params.el):$(i.params.content))&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;var s,o,l=$(i.params.targetEl).eq(0);if(0===n.length)return i.destroy();i.params.backdrop&&0===(s=t.root.children(".popover-backdrop")).length&&(s=$('<div class="popover-backdrop"></div>'),t.root.append(s)),0===n.find(".popover-angle").length?(o=$('<div class="popover-angle"></div>'),n.prepend(o)):o=n.find(".popover-angle");var p=i.open;function c(){i.resize()}function d(e){var t=e.target;0===$(t).closest(i.el).length&&(i.params.closeByBackdropClick&&i.params.backdrop&&i.backdropEl&&i.backdropEl===t?i.close():i.params.closeByOutsideClick&&i.close())}return Utils.extend(i,{app:t,$el:n,el:n[0],$targetEl:l,targetEl:l[0],$angleEl:o,angleEl:o[0],$backdropEl:s,backdropEl:s&&s[0],type:"popover",open:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1];return"boolean"==typeof t[0]&&(n=(e=t)[0],r=e[1]),r&&(i.$targetEl=$(r),i.targetEl=i.$targetEl[0]),p.call(i,n)}}),i.on("popoverOpen",function(){i.resize(),t.on("resize",c),i.on("popoverClose popoverBeforeDestroy",function(){t.off("resize",c)})}),i.on("popoverOpened",function(){(i.params.closeByOutsideClick||i.params.closeByBackdropClick)&&t.on("click",d)}),i.on("popoverClose",function(){(i.params.closeByOutsideClick||i.params.closeByBackdropClick)&&t.off("click",d)}),n[0].f7Modal=i,i}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.resize=function(){var e=this.app,t=this.$el,a=this.$targetEl,r=this.$angleEl,n=this.params,i=n.targetX,s=n.targetY;t.css({left:"",top:""});var o,l,p,c,d,u,h=[t.width(),t.height()],f=h[0],v=h[1],m=0;if("ios"===e.theme||"aurora"===e.theme?(r.removeClass("on-left on-right on-top on-bottom").css({left:"",top:""}),m=r.width()/2):t.removeClass("popover-on-left popover-on-right popover-on-top popover-on-bottom").css({left:"",top:""}),a&&a.length>0){p=a.outerWidth(),c=a.outerHeight();var g=a.offset();d=g.left-e.left,u=g.top-e.top;var b=a.parents(".page");b.length>0&&(u-=b[0].scrollTop)}else void 0!==i&&"undefined"!==s&&(d=i,u=s,p=this.params.targetWidth||0,c=this.params.targetHeight||0);var y=[0,0,0],w=y[0],C=y[1],x=y[2],$="md"===e.theme?"bottom":"top";"md"===e.theme?(v<e.height-u-c?($="bottom",C=u):v<u?(C=u-v+c,$="top"):($="bottom",C=u),C<=0?C=8:C+v>=e.height&&(C=e.height-v-8),(w=d+p-f-8)+f>=e.width-8&&(w=d+p-f-8),w<8&&(w=8),"top"===$&&t.addClass("popover-on-top"),"bottom"===$&&t.addClass("popover-on-bottom")):(v+m<u?C=u-v-m:v+m<e.height-u-c?($="bottom",C=u+c+m):($="middle",x=C=c/2+u-v/2,C<=0?C=5:C+v>=e.height&&(C=e.height-v-5),x-=C),"top"===$||"bottom"===$?(x=w=p/2+d-f/2,w<5&&(w=5),w+f>e.width&&(w=e.width-f-5),w<0&&(w=0),"top"===$&&r.addClass("on-bottom"),"bottom"===$&&r.addClass("on-top"),o=f/2-m+(x-=w),o=Math.max(Math.min(o,f-2*m-13),13),r.css({left:o+"px"})):"middle"===$&&(w=d-f-m,r.addClass("on-right"),(w<5||w+f>e.width)&&(w<5&&(w=d+p+m),w+f>e.width&&(w=e.width-f-5),r.removeClass("on-right").addClass("on-left")),l=v/2-m+x,l=Math.max(Math.min(l,v-2*m-13),13),r.css({top:l+"px"}))),t.css({top:C+"px",left:w+"px"})},t}(Modal),Popover$1={name:"popover",params:{popover:{closeByBackdropClick:!0,closeByOutsideClick:!0,backdrop:!0}},static:{Popover:Popover},create:function(){var e=this;e.popover=Utils.extend(ModalMethods({app:e,constructor:Popover,defaultSelector:".popover.modal-in"}),{open:function(t,a,r){var n=$(t),i=n[0].f7Modal;return i||(i=new Popover(e,{el:n,targetEl:a})),i.open(a,r)}})},clicks:{".popover-open":function(e,t){void 0===t&&(t={});this.popover.open(t.popover,e,t.animate)},".popover-close":function(e,t){void 0===t&&(t={});this.popover.close(t.popover,t.animate)}}},Actions=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.actions,a);e.call(this,t,r);var n,i,s,o=this;if(o.params=r,o.params.buttons&&(n=o.params.buttons,Array.isArray(n[0])||(n=[n])),o.groups=n,o.params.el?i=$(o.params.el):o.params.content?i=$(o.params.content):o.params.buttons&&(o.params.convertToPopover&&(o.popoverHtml=o.renderPopover()),o.actionsHtml=o.render()),i&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(i&&0===i.length&&!o.actionsHtml&&!o.popoverHtml)return o.destroy();o.params.backdrop&&0===(s=t.root.children(".actions-backdrop")).length&&(s=$('<div class="actions-backdrop"></div>'),t.root.append(s));var l,p=o.open,c=o.close;function d(e){var t,a;if($(this).hasClass("list-button")?(t=$(this).parents("li").index(),a=$(this).parents(".list").index()):(t=$(this).index(),a=$(this).parents(".actions-group").index()),void 0!==n){var r=n[a][t];r.onClick&&r.onClick(o,e),o.params.onClick&&o.params.onClick(o,e),!1!==r.close&&o.close()}}function u(e){var t=e.target;0===$(t).closest(o.el).length&&(o.params.closeByBackdropClick&&o.params.backdrop&&o.backdropEl&&o.backdropEl===t?o.close():o.params.closeByOutsideClick&&o.close())}return o.open=function(e){var a=!1,r=o.params,n=r.targetEl,i=r.targetX,s=r.targetY,c=r.targetWidth,u=r.targetHeight;return o.params.convertToPopover&&(n||void 0!==i&&void 0!==s)&&(o.params.forceToPopover||t.device.ios&&t.device.ipad||t.width>=768||t.device.desktop&&"aurora"===t.theme)&&(a=!0),a&&o.popoverHtml?((l=t.popover.create({content:o.popoverHtml,backdrop:o.params.backdrop,targetEl:n,targetX:i,targetY:s,targetWidth:c,targetHeight:u})).open(e),l.once("popoverOpened",function(){l.$el.find(".list-button").each(function(e,t){$(t).on("click",d)})}),l.once("popoverClosed",function(){l.$el.find(".list-button").each(function(e,t){$(t).off("click",d)}),Utils.nextTick(function(){l.destroy(),l=void 0})})):(o.$el=o.actionsHtml?$(o.actionsHtml):o.$el,o.$el[0].f7Modal=o,o.groups&&(o.$el.find(".actions-button").each(function(e,t){$(t).on("click",d)}),o.once("actionsClosed",function(){o.$el.find(".actions-button").each(function(e,t){$(t).off("click",d)})})),o.el=o.$el[0],p.call(o,e)),o},o.close=function(e){return l?l.close(e):c.call(o,e),o},Utils.extend(o,{app:t,$el:i,el:i?i[0]:void 0,$backdropEl:s,backdropEl:s&&s[0],type:"actions"}),o.on("opened",function(){(o.params.closeByBackdropClick||o.params.closeByOutsideClick)&&t.on("click",u)}),o.on("close",function(){(o.params.closeByBackdropClick||o.params.closeByOutsideClick)&&t.off("click",u)}),i&&(i[0].f7Modal=o),o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.groups;return('\n      <div class="actions-modal'+(this.params.grid?" actions-grid":"")+'">\n        '+e.map(function(e){return'<div class="actions-group">\n            '+e.map(function(e){var t=["actions-"+(e.label?"label":"button")],a=e.color,r=e.bg,n=e.bold,i=e.disabled,s=e.label,o=e.text,l=e.icon;return a&&t.push("color-"+a),r&&t.push("bg-color-"+r),n&&t.push("actions-button-bold"),i&&t.push("disabled"),s?'<div class="'+t.join(" ")+'">'+o+"</div>":('\n                <div class="'+t.join(" ")+'">\n                  '+(l?'<div class="actions-button-media">'+l+"</div>":"")+'\n                  <div class="actions-button-text">'+o+"</div>\n                </div>").trim()}).join("")+"\n          </div>"}).join("")+"\n      </div>\n    ").trim()},t.prototype.renderPopover=function(){return this.params.renderPopover?this.params.renderPopover.call(this,this):('\n      <div class="popover popover-from-actions">\n        <div class="popover-inner">\n          '+this.groups.map(function(e){return'\n            <div class="list">\n              <ul>\n                '+e.map(function(e){var t=[],a=e.color,r=e.bg,n=e.bold,i=e.disabled,s=e.label,o=e.text,l=e.icon;return a&&t.push("color-"+a),r&&t.push("bg-color-"+r),n&&t.push("popover-from-actions-bold"),i&&t.push("disabled"),s?(t.push("popover-from-actions-label"),'<li class="'+t.join(" ")+'">'+o+"</li>"):l?(t.push("item-link item-content"),'\n                      <li>\n                        <a class="'+t.join(" ")+'">\n                          <div class="item-media">\n                            '+l+'\n                          </div>\n                          <div class="item-inner">\n                            <div class="item-title">\n                              '+o+"\n                            </div>\n                          </div>\n                        </a>\n                      </li>\n                    "):(t.push("list-button"),'\n                    <li>\n                      <a href="#" class="'+t.join(" ")+'">'+o+"</a>\n                    </li>\n                  ")}).join("")+"\n              </ul>\n            </div>\n          "}).join("")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Actions$1={name:"actions",params:{actions:{convertToPopover:!0,forceToPopover:!1,closeByBackdropClick:!0,render:null,renderPopover:null,backdrop:!0}},static:{Actions:Actions},create:function(){this.actions=ModalMethods({app:this,constructor:Actions,defaultSelector:".actions-modal.modal-in"})},clicks:{".actions-open":function(e,t){void 0===t&&(t={});this.actions.open(t.actions,t.animate)},".actions-close":function(e,t){void 0===t&&(t={});this.actions.close(t.actions,t.animate)}}},Sheet=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.sheet,a);e.call(this,t,r);var n,i,s,o=this;if(o.params=r,(n=o.params.el?$(o.params.el):$(o.params.content))&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(0===n.length)return o.destroy();function l(e){var t=e.target;0===$(t).closest(o.el).length&&(o.params.closeByBackdropClick&&o.params.backdrop&&o.backdropEl&&o.backdropEl===t?o.close():o.params.closeByOutsideClick&&o.close())}return o.params.backdrop&&0===(i=t.root.children(".sheet-backdrop")).length&&(i=$('<div class="sheet-backdrop"></div>'),t.root.append(i)),o.on("sheetOpen",function(){o.params.scrollToEl&&function(){var e=$(o.params.scrollToEl).eq(0);if(0!==e.length&&0!==(s=e.parents(".page-content")).length){var t,a=parseInt(s.css("padding-top"),10),r=parseInt(s.css("padding-bottom"),10),i=s[0].offsetHeight-a-n.height(),l=s[0].scrollHeight-a-n.height(),p=s.scrollTop(),c=e.offset().top-a+e[0].offsetHeight;if(c>i){var d=p+c-i;d+i>l&&(t=d+i-l+r,i===l&&(t=n.height()),s.css({"padding-bottom":t+"px"})),s.scrollTop(d,300)}}}()}),o.on("sheetOpened",function(){(o.params.closeByOutsideClick||o.params.closeByBackdropClick)&&t.on("click",l)}),o.on("sheetClose",function(){o.params.scrollToEl&&s&&s.length>0&&s.css({"padding-bottom":""}),(o.params.closeByOutsideClick||o.params.closeByBackdropClick)&&t.off("click",l)}),Utils.extend(o,{app:t,$el:n,el:n[0],$backdropEl:i,backdropEl:i&&i[0],type:"sheet"}),n[0].f7Modal=o,o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Sheet$1={name:"sheet",params:{sheet:{closeByBackdropClick:!0,closeByOutsideClick:!1}},static:{Sheet:Sheet},create:function(){this.passedParams.sheet&&void 0!==this.passedParams.sheet.backdrop||(this.params.sheet.backdrop="ios"!==this.theme),this.sheet=Utils.extend({},ModalMethods({app:this,constructor:Sheet,defaultSelector:".sheet-modal.modal-in"}))},clicks:{".sheet-open":function(e,t){void 0===t&&(t={});$(".sheet-modal.modal-in").length>0&&t.sheet&&$(t.sheet)[0]!==$(".sheet-modal.modal-in")[0]&&this.sheet.close(".sheet-modal.modal-in"),this.sheet.open(t.sheet,t.animate)},".sheet-close":function(e,t){void 0===t&&(t={});this.sheet.close(t.sheet,t.animate)}}},Toast=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.toast,a);e.call(this,t,r);var n=this;n.app=t,n.params=r;var i,s,o=n.params,l=o.closeButton,p=o.closeTimeout;if(n.params.el)i=$(n.params.el);else{var c=n.render();i=$(c)}return i&&i.length>0&&i[0].f7Modal?i[0].f7Modal:0===i.length?n.destroy():(Utils.extend(n,{$el:i,el:i[0],type:"toast"}),i[0].f7Modal=n,l&&(i.find(".toast-button").on("click",function(){n.emit("local::closeButtonClick toastCloseButtonClick",n),n.close()}),n.on("beforeDestroy",function(){i.find(".toast-button").off("click")})),n.on("open",function(){$(".toast.modal-in").each(function(e,a){var r=t.toast.get(a);a!==n.el&&r&&r.close()}),p&&(s=Utils.nextTick(function(){n.close()},p))}),n.on("close",function(){win.clearTimeout(s)}),n.params.destroyOnClose&&n.once("closed",function(){setTimeout(function(){n.destroy()},0)}),n)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.position,a=e.cssClass,r=e.icon,n=e.text,i=e.closeButton,s=e.closeButtonColor,o=e.closeButtonText;return('\n      <div class="toast toast-'+t+" "+(a||"")+" "+(r?"toast-with-icon":"")+'">\n        <div class="toast-content">\n          '+(r?'<div class="toast-icon">'+r+"</div>":"")+'\n          <div class="toast-text">'+n+"</div>\n          "+(i&&!r?('\n          <a class="toast-button button '+(s?"color-"+s:"")+'">'+o+"</a>\n          ").trim():"")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Toast$1={name:"toast",static:{Toast:Toast},create:function(){var e=this;e.toast=Utils.extend({},ModalMethods({app:e,constructor:Toast,defaultSelector:".toast.modal-in"}),{show:function(t){return Utils.extend(t,{destroyOnClose:!0}),new Toast(e,t).open()}})},params:{toast:{icon:null,text:null,position:"bottom",closeButton:!1,closeButtonColor:null,closeButtonText:"Ok",closeTimeout:null,cssClass:null,render:null}}},Preloader={init:function(e){var t=$(e);0===t.length||t.children(".preloader-inner").length>0||t.children(".preloader-inner-line").length>0||t.append(Utils[this.theme+"PreloaderContent"])},visible:!1,show:function(e){void 0===e&&(e="white");if(!Preloader.visible){var t=Utils[this.theme+"PreloaderContent"]||"";$("html").addClass("with-modal-preloader"),this.root.append('\n      <div class="preloader-backdrop"></div>\n      <div class="preloader-modal">\n        <div class="preloader color-'+e+'">'+t+"</div>\n      </div>\n    "),Preloader.visible=!0}},hide:function(){Preloader.visible&&($("html").removeClass("with-modal-preloader"),this.root.find(".preloader-backdrop, .preloader-modal").remove(),Preloader.visible=!1)}},Preloader$1={name:"preloader",create:function(){Utils.extend(this,{preloader:{init:Preloader.init.bind(this),show:Preloader.show.bind(this),hide:Preloader.hide.bind(this)}})},on:{photoBrowserOpen:function(e){var t=this;e.$el.find(".preloader").each(function(e,a){t.preloader.init(a)})},pageInit:function(e){var t=this;e.$el.find(".preloader").each(function(e,a){t.preloader.init(a)})}},vnode:{preloader:{insert:function(e){var t=e.elm;this.preloader.init(t)}}}},Progressbar={set:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],n=t[1],i=t[2];if("number"==typeof t[0]&&(n=(e=t)[0],i=e[1],r=this.root),null==n)return r;n||(n=0);var s=$(r||this.root);if(0===s.length)return r;var o,l=Math.min(Math.max(n,0),100);if(0===(o=s.hasClass("progressbar")?s.eq(0):s.children(".progressbar")).length||o.hasClass("progressbar-infinite"))return o;var p=o.children("span");return 0===p.length&&(p=$("<span></span>"),o.append(p)),p.transition(void 0!==i?i:"").transform("translate3d("+(-100+l)+"%,0,0)"),o[0]},show:function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var n=a[0],i=a[1],s=a[2],o="determined";2===a.length?"string"!=typeof a[0]&&"object"!=typeof a[0]||"string"!=typeof a[1]?"number"==typeof a[0]&&"string"==typeof a[1]&&(i=(t=a)[0],s=t[1],n=this.root):(n=(e=a)[0],s=e[1],i=e[2],o="infinite"):1===a.length?"number"==typeof a[0]?(n=this.root,i=a[0]):"string"==typeof a[0]&&(o="infinite",n=this.root,s=a[0]):0===a.length&&(o="infinite",n=this.root);var l,p=$(n);if(0!==p.length)return p.hasClass("progressbar")||p.hasClass("progressbar-infinite")?l=p:0===(l=p.children(".progressbar:not(.progressbar-out), .progressbar-infinite:not(.progressbar-out)")).length&&(l=$('\n          <span class="progressbar'+("infinite"===o?"-infinite":"")+(s?" color-"+s:"")+' progressbar-in">\n            '+("infinite"===o?"":"<span></span>")+"\n          </span>"),p.append(l)),void 0!==i&&this.progressbar.set(l,i),l[0]},hide:function(e,t){void 0===t&&(t=!0);var a,r=$(e||this.root);if(0!==r.length)return 0===(a=r.hasClass("progressbar")||r.hasClass("progressbar-infinite")?r:r.children(".progressbar, .progressbar-infinite")).length||!a.hasClass("progressbar-in")||a.hasClass("progressbar-out")?a:(a.removeClass("progressbar-in").addClass("progressbar-out").animationEnd(function(){t&&a.remove()}),a)}},Progressbar$1={name:"progressbar",create:function(){Utils.extend(this,{progressbar:{set:Progressbar.set.bind(this),show:Progressbar.show.bind(this),hide:Progressbar.hide.bind(this)}})},on:{pageInit:function(e){var t=this;e.$el.find(".progressbar").each(function(e,a){var r=$(a);t.progressbar.set(r,r.attr("data-progress"))})}}},Sortable={init:function(){var e,t,a,r,n,i,s,o,l,p,c,d,u,h,f,v,m,g,b,y,w=this;var C=!!w.support.passiveListener&&{passive:!1,capture:!1};$(doc).on(w.touchEvents.start,".list.sortable .sortable-handler",function(r){t=!1,e=!0,a="touchstart"===r.type?r.targetTouches[0].pageY:r.pageY,n=$(this).parent("li"),u=n.index(),s=n.parents(".sortable");var o=n.parents(".list-group");o.length&&o.parents(s).length&&(s=o),i=s.children("ul").children("li"),w.panel&&(w.panel.allowOpen=!1),w.swipeout&&(w.swipeout.allow=!1)},C),w.on("touchmove:active",function(u){if(e&&n){var w="touchmove"===u.type?u.targetTouches[0].pageY:u.pageY;if(!t){h=n.parents(".page"),f=n.parents(".page-content");var C=parseInt(f.css("padding-top"),10),x=parseInt(f.css("padding-bottom"),10);y=f[0].scrollTop,m=h.offset().top+C,v=h.height()-C-x,n.addClass("sorting"),s.addClass("sortable-sorting"),g=n[0].offsetTop,l=n[0].offsetTop,p=n.parent().height()-g-n.height(),o=n[0].offsetHeight,b=n.offset().top}t=!0,u.preventDefault(),u.f7PreventSwipePanel=!0,r=w-a;var E=f[0].scrollTop-y,k=Math.min(Math.max(r+E,-l),p);n.transform("translate3d(0,"+k+"px,0)");var S,T=!0;r+E+44<-l&&(T=!1),r+E-44>p&&(T=!1),d=void 0,c=void 0,T&&(b+r+o+44>m+v&&(S=b+r+o+44-(m+v)),b+r<m+44&&(S=b+r-m-44),S&&(f[0].scrollTop+=S)),i.each(function(e,t){var a=$(t);if(a[0]!==n[0]){var r=a[0].offsetTop,i=a.height(),s=g+k;s>=r-i/2&&n.index()<a.index()?(a.transform("translate3d(0, "+-o+"px,0)"),c=a,d=void 0):s<=r+i/2&&n.index()>a.index()?(a.transform("translate3d(0, "+o+"px,0)"),c=void 0,d||(d=a)):a.transform("translate3d(0, 0%,0)")}})}}),w.on("touchend:passive",function(){if(!e||!t)return t=!1,void((e=!1)&&!t&&(w.panel&&(w.panel.allowOpen=!0),w.swipeout&&(w.swipeout.allow=!0)));var a;if(w.panel&&(w.panel.allowOpen=!0),w.swipeout&&(w.swipeout.allow=!0),i.transform(""),n.removeClass("sorting"),s.removeClass("sortable-sorting"),c?a=c.index():d&&(a=d.index()),w.params.sortable.moveElements&&(c&&n.insertAfter(c),d&&n.insertBefore(d)),(c||d)&&s.hasClass("virtual-list")){void 0===(u=n[0].f7VirtualListIndex)&&(u=n.attr("data-virtual-list-index")),d?void 0===(a=d[0].f7VirtualListIndex)&&(a=d.attr("data-virtual-list-index")):void 0===(a=c[0].f7VirtualListIndex)&&(a=c.attr("data-virtual-list-index")),a=null!==a?parseInt(a,10):void 0;var r=s[0].f7VirtualList;r&&r.moveItem(u,a)}void 0===a||Number.isNaN(a)||a===u||(n.trigger("sortable:sort",{from:u,to:a}),w.emit("sortableSort",n[0],{from:u,to:a})),d=void 0,c=void 0,e=!1,t=!1})},enable:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.addClass("sortable-enabled"),t.trigger("sortable:enable"),this.emit("sortableEnable",t[0]))},disable:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.removeClass("sortable-enabled"),t.trigger("sortable:disable"),this.emit("sortableDisable",t[0]))},toggle:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.hasClass("sortable-enabled")?this.sortable.disable(t):this.sortable.enable(t))}},Sortable$1={name:"sortable",params:{sortable:{moveElements:!0}},create:function(){Utils.extend(this,{sortable:{init:Sortable.init.bind(this),enable:Sortable.enable.bind(this),disable:Sortable.disable.bind(this),toggle:Sortable.toggle.bind(this)}})},on:{init:function(){this.params.sortable&&this.sortable.init()}},clicks:{".sortable-enable":function(e,t){void 0===t&&(t={});this.sortable.enable(t.sortable)},".sortable-disable":function(e,t){void 0===t&&(t={});this.sortable.disable(t.sortable)},".sortable-toggle":function(e,t){void 0===t&&(t={});this.sortable.toggle(t.sortable)}}},Swipeout={init:function(){var e,t,a,r,n,i,s,o,l,p,c,d,u,h,f,v,m,g,b,y,w,C=this,x={};var E=!!C.support.passiveListener&&{passive:!0};C.on("touchstart",function(e){if(Swipeout.el){var t=$(e.target);$(Swipeout.el).is(t[0])||t.parents(".swipeout").is(Swipeout.el)||t.hasClass("modal-in")||(t.attr("class")||"").indexOf("-backdrop")>0||t.hasClass("actions-modal")||t.parents(".actions-modal.modal-in, .dialog.modal-in").length>0||C.swipeout.close(Swipeout.el)}}),$(doc).on(C.touchEvents.start,"li.swipeout",function(n){Swipeout.allow&&(t=!1,e=!0,a=void 0,x.x="touchstart"===n.type?n.targetTouches[0].pageX:n.pageX,x.y="touchstart"===n.type?n.targetTouches[0].pageY:n.pageY,r=(new Date).getTime(),i=$(this))},E),C.on("touchmove:active",function(r){if(e){var E="touchmove"===r.type?r.targetTouches[0].pageX:r.pageX,k="touchmove"===r.type?r.targetTouches[0].pageY:r.pageY;if(void 0===a&&(a=!!(a||Math.abs(k-x.y)>Math.abs(E-x.x))),a)e=!1;else{if(!t){if($(".list.sortable-opened").length>0)return;s=i.find(".swipeout-content"),o=i.find(".swipeout-actions-right"),l=i.find(".swipeout-actions-left"),p=null,c=null,f=null,v=null,b=null,g=null,l.length>0&&(p=l.outerWidth(),f=l.children("a"),g=l.find(".swipeout-overswipe")),o.length>0&&(c=o.outerWidth(),v=o.children("a"),b=o.find(".swipeout-overswipe")),(u=i.hasClass("swipeout-opened"))&&(h=i.find(".swipeout-actions-left.swipeout-actions-opened").length>0?"left":"right"),i.removeClass("swipeout-transitioning"),C.params.swipeout.noFollow||(i.find(".swipeout-actions-opened").removeClass("swipeout-actions-opened"),i.removeClass("swipeout-opened"))}if(t=!0,r.preventDefault(),n=E-x.x,d=n,u&&("right"===h?d-=c:d+=p),d>0&&0===l.length||d<0&&0===o.length){if(!u)return e=!1,t=!1,s.transform(""),v&&v.length>0&&v.transform(""),void(f&&f.length>0&&f.transform(""));d=0}var S,T;if(d<0?m="to-left":d>0?m="to-right":m||(m="to-left"),r.f7PreventSwipePanel=!0,C.params.swipeout.noFollow)return u?("right"===h&&n>0&&C.swipeout.close(i),"left"===h&&n<0&&C.swipeout.close(i)):(n<0&&o.length>0&&C.swipeout.open(i,"right"),n>0&&l.length>0&&C.swipeout.open(i,"left")),e=!1,void(t=!1);if(y=!1,w=!1,o.length>0){var M=d;T=M/c,M<-c&&(M=-c-Math.pow(-M-c,.8),d=M,b.length>0&&(w=!0)),"to-left"!==m&&(T=0,M=0),v.each(function(e,t){var a=$(t);void 0===t.f7SwipeoutButtonOffset&&(a[0].f7SwipeoutButtonOffset=t.offsetLeft),S=t.f7SwipeoutButtonOffset,b.length>0&&a.hasClass("swipeout-overswipe")&&"to-left"===m&&(a.css({left:(w?-S:0)+"px"}),w?(a.hasClass("swipeout-overswipe-active")||(i.trigger("swipeout:overswipeenter"),C.emit("swipeoutOverswipeEnter",i[0])),a.addClass("swipeout-overswipe-active")):(a.hasClass("swipeout-overswipe-active")&&(i.trigger("swipeout:overswipeexit"),C.emit("swipeoutOverswipeExit",i[0])),a.removeClass("swipeout-overswipe-active"))),a.transform("translate3d("+(M-S*(1+Math.max(T,-1)))+"px,0,0)")})}if(l.length>0){var P=d;T=P/p,P>p&&(P=p+Math.pow(P-p,.8),d=P,g.length>0&&(y=!0)),"to-right"!==m&&(P=0,T=0),f.each(function(e,t){var a=$(t);void 0===t.f7SwipeoutButtonOffset&&(a[0].f7SwipeoutButtonOffset=p-t.offsetLeft-t.offsetWidth),S=t.f7SwipeoutButtonOffset,g.length>0&&a.hasClass("swipeout-overswipe")&&"to-right"===m&&(a.css({left:(y?S:0)+"px"}),y?(a.hasClass("swipeout-overswipe-active")||(i.trigger("swipeout:overswipeenter"),C.emit("swipeoutOverswipeEnter",i[0])),a.addClass("swipeout-overswipe-active")):(a.hasClass("swipeout-overswipe-active")&&(i.trigger("swipeout:overswipeexit"),C.emit("swipeoutOverswipeExit",i[0])),a.removeClass("swipeout-overswipe-active"))),f.length>1&&a.css("z-index",f.length-e),a.transform("translate3d("+(P+S*(1-Math.min(T,1)))+"px,0,0)")})}i.trigger("swipeout",T),C.emit("swipeout",i[0],T),s.transform("translate3d("+d+"px,0,0)")}}}),C.on("touchend:passive",function(){if(!e||!t)return e=!1,void(t=!1);e=!1,t=!1;var a,h,g,b,x=(new Date).getTime()-r,E="to-left"===m?o:l,k="to-left"===m?c:p;if(a=x<300&&(n<-10&&"to-left"===m||n>10&&"to-right"===m)||x>=300&&Math.abs(d)>k/2?"open":"close",x<300&&(0===Math.abs(d)&&(a="close"),Math.abs(d)===k&&(a="open")),"open"===a){Swipeout.el=i[0],i.trigger("swipeout:open"),C.emit("swipeoutOpen",i[0]),i.addClass("swipeout-opened swipeout-transitioning");var S="to-left"===m?-k:k;if(s.transform("translate3d("+S+"px,0,0)"),E.addClass("swipeout-actions-opened"),h="to-left"===m?v:f)for(g=0;g<h.length;g+=1)$(h[g]).transform("translate3d("+S+"px,0,0)");w&&o.find(".swipeout-overswipe")[0].click(),y&&l.find(".swipeout-overswipe")[0].click()}else i.trigger("swipeout:close"),C.emit("swipeoutClose",i[0]),Swipeout.el=void 0,i.addClass("swipeout-transitioning").removeClass("swipeout-opened"),s.transform(""),E.removeClass("swipeout-actions-opened");f&&f.length>0&&f!==h&&f.each(function(e,t){var a=$(t);void 0===(b=t.f7SwipeoutButtonOffset)&&(a[0].f7SwipeoutButtonOffset=p-t.offsetLeft-t.offsetWidth),a.transform("translate3d("+b+"px,0,0)")}),v&&v.length>0&&v!==h&&v.each(function(e,t){var a=$(t);void 0===(b=t.f7SwipeoutButtonOffset)&&(a[0].f7SwipeoutButtonOffset=t.offsetLeft),a.transform("translate3d("+-b+"px,0,0)")}),s.transitionEnd(function(){u&&"open"===a||!u&&"close"===a||(i.trigger("open"===a?"swipeout:opened":"swipeout:closed"),C.emit("open"===a?"swipeoutOpened":"swipeoutClosed",i[0]),i.removeClass("swipeout-transitioning"),u&&"close"===a&&(o.length>0&&v.transform(""),l.length>0&&f.transform("")))})})},allow:!0,el:void 0,open:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=this,n=t[0],i=t[1],s=t[2];"function"==typeof t[1]&&(n=(e=t)[0],s=e[1],i=e[2]);var o=$(n).eq(0);if(0!==o.length&&o.hasClass("swipeout")&&!o.hasClass("swipeout-opened")){i||(i=o.find(".swipeout-actions-right").length>0?"right":"left");var l=o.find(".swipeout-actions-"+i),p=o.find(".swipeout-content");if(0!==l.length){o.trigger("swipeout:open").addClass("swipeout-opened").removeClass("swipeout-transitioning"),r.emit("swipeoutOpen",o[0]),l.addClass("swipeout-actions-opened");var c=l.children("a"),d=l.outerWidth(),u="right"===i?-d:d;c.length>1&&c.each(function(e,t){var a=$(t);"right"===i?a.transform("translate3d("+-t.offsetLeft+"px,0,0)"):a.css("z-index",c.length-e).transform("translate3d("+(d-t.offsetWidth-t.offsetLeft)+"px,0,0)")}),o.addClass("swipeout-transitioning"),p.transitionEnd(function(){o.trigger("swipeout:opened"),r.emit("swipeoutOpened",o[0]),s&&s.call(o[0])}),Utils.nextFrame(function(){c.transform("translate3d("+u+"px,0,0)"),p.transform("translate3d("+u+"px,0,0)")}),Swipeout.el=o[0]}}},close:function(e,t){var a=this,r=$(e).eq(0);if(0!==r.length&&r.hasClass("swipeout-opened")){var n,i=r.find(".swipeout-actions-opened").hasClass("swipeout-actions-right")?"right":"left",s=r.find(".swipeout-actions-opened").removeClass("swipeout-actions-opened"),o=s.children("a"),l=s.outerWidth();Swipeout.allow=!1,r.trigger("swipeout:close"),a.emit("swipeoutClose",r[0]),r.removeClass("swipeout-opened").addClass("swipeout-transitioning"),r.find(".swipeout-content").transform("").transitionEnd(p),n=setTimeout(p,500),o.each(function(e,t){var a=$(t);"right"===i?a.transform("translate3d("+-t.offsetLeft+"px,0,0)"):a.transform("translate3d("+(l-t.offsetWidth-t.offsetLeft)+"px,0,0)"),a.css({left:"0px"}).removeClass("swipeout-overswipe-active")}),Swipeout.el&&Swipeout.el===r[0]&&(Swipeout.el=void 0)}function p(){Swipeout.allow=!0,r.hasClass("swipeout-opened")||(r.removeClass("swipeout-transitioning"),o.transform(""),r.trigger("swipeout:closed"),a.emit("swipeoutClosed",r[0]),t&&t.call(r[0]),n&&clearTimeout(n))}},delete:function(e,t){var a=this,r=$(e).eq(0);0!==r.length&&(Swipeout.el=void 0,r.trigger("swipeout:delete"),a.emit("swipeoutDelete",r[0]),r.css({height:r.outerHeight()+"px"}),r.transitionEnd(function(){if(r.trigger("swipeout:deleted"),a.emit("swipeoutDeleted",r[0]),t&&t.call(r[0]),r.parents(".virtual-list").length>0){var e=r.parents(".virtual-list")[0].f7VirtualList,n=r[0].f7VirtualListIndex;e&&void 0!==n&&e.deleteItem(n)}else a.params.swipeout.removeElements?a.params.swipeout.removeElementsWithTimeout?setTimeout(function(){r.remove()},a.params.swipeout.removeElementsTimeout):r.remove():r.removeClass("swipeout-deleting swipeout-transitioning")}),Utils.nextFrame(function(){r.addClass("swipeout-deleting swipeout-transitioning").css({height:"0px"}).find(".swipeout-content").transform("translate3d(-100%,0,0)")}))}},Swipeout$1={name:"swipeout",params:{swipeout:{actionsNoFold:!1,noFollow:!1,removeElements:!0,removeElementsWithTimeout:!1,removeElementsTimeout:0}},create:function(){Utils.extend(this,{swipeout:{init:Swipeout.init.bind(this),open:Swipeout.open.bind(this),close:Swipeout.close.bind(this),delete:Swipeout.delete.bind(this)}}),Object.defineProperty(this.swipeout,"el",{enumerable:!0,configurable:!0,get:function(){return Swipeout.el},set:function(e){Swipeout.el=e}}),Object.defineProperty(this.swipeout,"allow",{enumerable:!0,configurable:!0,get:function(){return Swipeout.allow},set:function(e){Swipeout.allow=e}})},clicks:{".swipeout-open":function(e,t){void 0===t&&(t={});this.swipeout.open(t.swipeout,t.side)},".swipeout-close":function(e){var t=e.closest(".swipeout");0!==t.length&&this.swipeout.close(t)},".swipeout-delete":function(e,t){void 0===t&&(t={});var a=this,r=e.closest(".swipeout");if(0!==r.length){var n=t.confirm,i=t.confirmTitle;t.confirm?a.dialog.confirm(n,i,function(){a.swipeout.delete(r)}):a.swipeout.delete(r)}}},on:{init:function(){this.params.swipeout&&this.swipeout.init()}}},Accordion={toggleClicked:function(e){var t=e.closest(".accordion-item").eq(0);t.length||(t=e.parents("li").eq(0));var a=e.parents(".accordion-item-content").eq(0);a.length&&a.parents(t).length||e.parents("li").length>1&&e.parents("li")[0]!==t[0]||this.accordion.toggle(t)},open:function(e){var t=this,a=$(e),r=!1;function n(){r=!0}if(a.trigger("accordion:beforeopen",{prevent:n},n),t.emit("accordionBeforeOpen",a[0],n),!r){var i=a.parents(".accordion-list").eq(0),s=a.children(".accordion-item-content");if(s.removeAttr("aria-hidden"),0===s.length&&(s=a.find(".accordion-item-content")),0!==s.length){var o=i.length>0&&a.parent().children(".accordion-item-opened");o.length>0&&t.accordion.close(o),s.transitionEnd(function(){a.hasClass("accordion-item-opened")?(s.transition(0),s.css("height","auto"),Utils.nextFrame(function(){s.transition(""),a.trigger("accordion:opened"),t.emit("accordionOpened",a[0])})):(s.css("height",""),a.trigger("accordion:closed"),t.emit("accordionClosed",a[0]))}),s.css("height",s[0].scrollHeight+"px"),a.trigger("accordion:open"),a.addClass("accordion-item-opened"),t.emit("accordionOpen",a[0])}}},close:function(e){var t=this,a=$(e),r=!1;function n(){r=!0}if(a.trigger("accordion:beforeclose",{prevent:n},n),t.emit("accordionBeforeClose",a[0],n),!r){var i=a.children(".accordion-item-content");0===i.length&&(i=a.find(".accordion-item-content")),a.removeClass("accordion-item-opened"),i.attr("aria-hidden",!0),i.transition(0),i.css("height",i[0].scrollHeight+"px"),i.transitionEnd(function(){a.hasClass("accordion-item-opened")?(i.transition(0),i.css("height","auto"),Utils.nextFrame(function(){i.transition(""),a.trigger("accordion:opened"),t.emit("accordionOpened",a[0])})):(i.css("height",""),a.trigger("accordion:closed"),t.emit("accordionClosed",a[0]))}),Utils.nextFrame(function(){i.transition(""),i.css("height",""),a.trigger("accordion:close"),t.emit("accordionClose",a[0])})}},toggle:function(e){var t=$(e);0!==t.length&&(t.hasClass("accordion-item-opened")?this.accordion.close(e):this.accordion.open(e))}},Accordion$1={name:"accordion",create:function(){Utils.extend(this,{accordion:{open:Accordion.open.bind(this),close:Accordion.close.bind(this),toggle:Accordion.toggle.bind(this)}})},clicks:{".accordion-item .item-link, .accordion-item-toggle, .links-list.accordion-list > ul > li > a":function(e){Accordion.toggleClicked.call(this,e)}}},ContactsList={name:"contactsList"},VirtualList=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,n=this;"md"===t.theme?r=48:"ios"===t.theme?r=44:"aurora"===t.theme&&(r=38);var i={cols:1,height:r,cache:!0,dynamicHeightBufferSize:1,showFilteredItemsOnly:!1,renderExternal:void 0,setListHeight:!0,searchByItem:void 0,searchAll:void 0,itemTemplate:void 0,ul:null,createUl:!0,renderItem:function(e){return('\n          <li>\n            <div class="item-content">\n              <div class="item-inner">\n                <div class="item-title">'+e+"</div>\n              </div>\n            </div>\n          </li>\n        ").trim()},on:{}};if(n.useModulesParams(i),n.params=Utils.extend(i,a),void 0!==n.params.height&&n.params.height||(n.params.height=r),n.$el=$(a.el),n.el=n.$el[0],0!==n.$el.length){n.$el[0].f7VirtualList=n,n.items=n.params.items,n.params.showFilteredItemsOnly&&(n.filteredItems=[]),n.params.itemTemplate?"string"==typeof n.params.itemTemplate?n.renderItem=t.t7.compile(n.params.itemTemplate):"function"==typeof n.params.itemTemplate&&(n.renderItem=n.params.itemTemplate):n.params.renderItem&&(n.renderItem=n.params.renderItem),n.$pageContentEl=n.$el.parents(".page-content"),n.pageContentEl=n.$pageContentEl[0],void 0!==n.params.updatableScroll?n.updatableScroll=n.params.updatableScroll:(n.updatableScroll=!0,Device.ios&&Device.osVersion.split(".")[0]<8&&(n.updatableScroll=!1));var s,o=n.params.ul;n.$ul=o?$(n.params.ul):n.$el.children("ul"),0===n.$ul.length&&n.params.createUl&&(n.$el.append("<ul></ul>"),n.$ul=n.$el.children("ul")),n.ul=n.$ul[0],s=n.ul||n.params.createUl?n.$ul:n.$el,Utils.extend(n,{$itemsWrapEl:s,itemsWrapEl:s[0],domCache:{},displayDomCache:{},tempDomElement:doc.createElement("ul"),lastRepaintY:null,fragment:doc.createDocumentFragment(),pageHeight:void 0,rowsPerScreen:void 0,rowsBefore:void 0,rowsAfter:void 0,rowsToRender:void 0,maxBufferHeight:0,listHeight:void 0,dynamicHeight:"function"==typeof n.params.height}),n.useModules();var l,p,c,d,u=n.handleScroll.bind(n),h=n.handleResize.bind(n);return n.attachEvents=function(){l=n.$el.parents(".page").eq(0),p=n.$el.parents(".tab").eq(0),c=n.$el.parents(".panel").eq(0),d=n.$el.parents(".popup").eq(0),n.$pageContentEl.on("scroll",u),l&&l.on("page:reinit",h),p&&p.on("tab:show",h),c&&c.on("panel:open",h),d&&d.on("popup:open",h),t.on("resize",h)},n.detachEvents=function(){n.$pageContentEl.off("scroll",u),l&&l.off("page:reinit",h),p&&p.off("tab:show",h),c&&c.off("panel:open",h),d&&d.off("popup:open",h),t.off("resize",h)},n.init(),n}}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setListSize=function(){var e=this,t=e.filteredItems||e.items;if(e.pageHeight=e.$pageContentEl[0].offsetHeight,e.dynamicHeight){e.listHeight=0,e.heights=[];for(var a=0;a<t.length;a+=1){var r=e.params.height(t[a]);e.listHeight+=r,e.heights.push(r)}}else e.listHeight=Math.ceil(t.length/e.params.cols)*e.params.height,e.rowsPerScreen=Math.ceil(e.pageHeight/e.params.height),e.rowsBefore=e.params.rowsBefore||2*e.rowsPerScreen,e.rowsAfter=e.params.rowsAfter||e.rowsPerScreen,e.rowsToRender=e.rowsPerScreen+e.rowsBefore+e.rowsAfter,e.maxBufferHeight=e.rowsBefore/2*e.params.height;(e.updatableScroll||e.params.setListHeight)&&e.$itemsWrapEl.css({height:e.listHeight+"px"})},t.prototype.render=function(e,t){var a=this;e&&(a.lastRepaintY=null);var r=-(a.$el[0].getBoundingClientRect().top-a.$pageContentEl[0].getBoundingClientRect().top);if(void 0!==t&&(r=t),null===a.lastRepaintY||Math.abs(r-a.lastRepaintY)>a.maxBufferHeight||!a.updatableScroll&&a.$pageContentEl[0].scrollTop+a.pageHeight>=a.$pageContentEl[0].scrollHeight){a.lastRepaintY=r;var n,i,s,o=a.filteredItems||a.items,l=0,p=0;if(a.dynamicHeight){var c,d=0;a.maxBufferHeight=a.pageHeight;for(var u=0;u<a.heights.length;u+=1)c=a.heights[u],void 0===n&&(d+c>=r-2*a.pageHeight*a.params.dynamicHeightBufferSize?n=u:l+=c),void 0===i&&((d+c>=r+2*a.pageHeight*a.params.dynamicHeightBufferSize||u===a.heights.length-1)&&(i=u+1),p+=c),d+=c;i=Math.min(i,o.length)}else(n=(parseInt(r/a.params.height,10)-a.rowsBefore)*a.params.cols)<0&&(n=0),i=Math.min(n+a.rowsToRender*a.params.cols,o.length);var h,f=[];for(a.reachEnd=!1,h=n;h<i;h+=1){var v=void 0,m=a.items.indexOf(o[h]);h===n&&(a.currentFromIndex=m),h===i-1&&(a.currentToIndex=m),a.filteredItems?a.items[m]===a.filteredItems[a.filteredItems.length-1]&&(a.reachEnd=!0):m===a.items.length-1&&(a.reachEnd=!0),a.params.renderExternal?f.push(o[h]):a.domCache[m]?(v=a.domCache[m]).f7VirtualListIndex=m:(a.renderItem?a.tempDomElement.innerHTML=a.renderItem(o[h],m).trim():a.tempDomElement.innerHTML=o[h].toString().trim(),v=a.tempDomElement.childNodes[0],a.params.cache&&(a.domCache[m]=v),v.f7VirtualListIndex=m),h===n&&(s=a.dynamicHeight?l:h*a.params.height/a.params.cols),a.params.renderExternal||(v.style.top=s+"px",a.emit("local::itemBeforeInsert vlItemBeforeInsert",a,v,o[h]),a.fragment.appendChild(v))}a.updatableScroll||(a.dynamicHeight?a.itemsWrapEl.style.height=p+"px":a.itemsWrapEl.style.height=h*a.params.height/a.params.cols+"px"),a.params.renderExternal?o&&0===o.length&&(a.reachEnd=!0):(a.emit("local::beforeClear vlBeforeClear",a,a.fragment),a.itemsWrapEl.innerHTML="",a.emit("local::itemsBeforeInsert vlItemsBeforeInsert",a,a.fragment),o&&0===o.length?(a.reachEnd=!0,a.params.emptyTemplate&&(a.itemsWrapEl.innerHTML=a.params.emptyTemplate)):a.itemsWrapEl.appendChild(a.fragment),a.emit("local::itemsAfterInsert vlItemsAfterInsert",a,a.fragment)),void 0!==t&&e&&a.$pageContentEl.scrollTop(t,0),a.params.renderExternal&&a.params.renderExternal(a,{fromIndex:n,toIndex:i,listHeight:a.listHeight,topPosition:s,items:f})}},t.prototype.filterItems=function(e,t){void 0===t&&(t=!0);var a=this;a.filteredItems=[];for(var r=0;r<e.length;r+=1)a.filteredItems.push(a.items[e[r]]);t&&(a.$pageContentEl[0].scrollTop=0),a.update()},t.prototype.resetFilter=function(){var e=this;e.params.showFilteredItemsOnly?e.filteredItems=[]:(e.filteredItems=null,delete e.filteredItems),e.update()},t.prototype.scrollToItem=function(e){var t=this;if(e>t.items.length)return!1;var a=0;if(t.dynamicHeight)for(var r=0;r<e;r+=1)a+=t.heights[r];else a=e*t.params.height;var n=t.$el[0].offsetTop;return t.render(!0,n+a-parseInt(t.$pageContentEl.css("padding-top"),10)),!0},t.prototype.handleScroll=function(){this.render()},t.prototype.isVisible=function(){return!!(this.el.offsetWidth||this.el.offsetHeight||this.el.getClientRects().length)},t.prototype.handleResize=function(){this.isVisible()&&(this.setListSize(),this.render(!0))},t.prototype.appendItems=function(e){for(var t=0;t<e.length;t+=1)this.items.push(e[t]);this.update()},t.prototype.appendItem=function(e){this.appendItems([e])},t.prototype.replaceAllItems=function(e){this.items=e,delete this.filteredItems,this.domCache={},this.update()},t.prototype.replaceItem=function(e,t){this.items[e]=t,this.params.cache&&delete this.domCache[e],this.update()},t.prototype.prependItems=function(e){for(var t=this,a=e.length-1;a>=0;a-=1)t.items.unshift(e[a]);if(t.params.cache){var r={};Object.keys(t.domCache).forEach(function(a){r[parseInt(a,10)+e.length]=t.domCache[a]}),t.domCache=r}t.update()},t.prototype.prependItem=function(e){this.prependItems([e])},t.prototype.moveItem=function(e,t){var a=this,r=e,n=t;if(r!==n){var i=a.items.splice(r,1)[0];if(n>=a.items.length?(a.items.push(i),n=a.items.length-1):a.items.splice(n,0,i),a.params.cache){var s={};Object.keys(a.domCache).forEach(function(e){var t=parseInt(e,10),i=r<n?r:n,o=r<n?n:r,l=r<n?-1:1;(t<i||t>o)&&(s[t]=a.domCache[t]),t===i&&(s[o]=a.domCache[t]),t>i&&t<=o&&(s[t+l]=a.domCache[t])}),a.domCache=s}a.update()}},t.prototype.insertItemBefore=function(e,t){var a=this;if(0!==e)if(e>=a.items.length)a.appendItem(t);else{if(a.items.splice(e,0,t),a.params.cache){var r={};Object.keys(a.domCache).forEach(function(t){var n=parseInt(t,10);n>=e&&(r[n+1]=a.domCache[n])}),a.domCache=r}a.update()}else a.prependItem(t)},t.prototype.deleteItems=function(e){for(var t,a=this,r=0,n=function(n){var i=e[n];void 0!==t&&i>t&&(r=-n),i+=r,t=e[n];var s=a.items.splice(i,1)[0];if(a.filteredItems&&a.filteredItems.indexOf(s)>=0&&a.filteredItems.splice(a.filteredItems.indexOf(s),1),a.params.cache){var o={};Object.keys(a.domCache).forEach(function(e){var t=parseInt(e,10);t===i?delete a.domCache[i]:parseInt(e,10)>i?o[t-1]=a.domCache[e]:o[t]=a.domCache[e]}),a.domCache=o}},i=0;i<e.length;i+=1)n(i);a.update()},t.prototype.deleteAllItems=function(){var e=this;e.items=[],delete e.filteredItems,e.params.cache&&(e.domCache={}),e.update()},t.prototype.deleteItem=function(e){this.deleteItems([e])},t.prototype.clearCache=function(){this.domCache={}},t.prototype.update=function(e){e&&this.params.cache&&(this.domCache={}),this.setListSize(),this.render(!0)},t.prototype.init=function(){this.attachEvents(),this.setListSize(),this.render()},t.prototype.destroy=function(){var e=this;e.detachEvents(),e.$el[0].f7VirtualList=null,delete e.$el[0].f7VirtualList,Utils.deleteProps(e),e=null},t}(Framework7Class),VirtualList$1={name:"virtualList",static:{VirtualList:VirtualList},create:function(){this.virtualList=ConstructorMethods({defaultSelector:".virtual-list",constructor:VirtualList,app:this,domProp:"f7VirtualList"})}},ListIndex=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,n,i,s,o=this,l={el:null,listEl:null,indexes:"auto",iosItemHeight:14,mdItemHeight:14,auroraItemHeight:14,scrollList:!0,label:!1,renderItem:function(e,t){return("\n          <li>"+e+"</li>\n        ").trim()},renderSkipPlaceholder:function(){return'<li class="list-index-skip-placeholder"></li>'},on:{}};if(o.useModulesParams(l),o.params=Utils.extend(l,a),!o.params.el)return o;if((r=$(o.params.el))[0].f7ListIndex)return r[0].f7ListIndex;if(0===(s=r.find("ul")).length&&(s=$("<ul></ul>"),r.append(s)),o.params.listEl&&(n=$(o.params.listEl)),"auto"===o.params.indexes&&!n)return o;function p(){var e={index:o};o.calcSize(),e!==o.height&&o.render()}function c(e){var t=$(e.target).closest("li");if(t.length){var a=t.index();if(o.skipRate>0){var r=a/(t.siblings("li").length-1);a=Math.round((o.indexes.length-1)*r)}var n=o.indexes[a];o.$el.trigger("listindex:click",n,a),o.emit("local::click listIndexClick",o,n,a),o.$el.trigger("listindex:select",n,a),o.emit("local::select listIndexSelect",o,n,a),o.$listEl&&o.params.scrollList&&o.scrollListToIndex(n,a)}}n?i=n.parents(".page-content").eq(0):0===(i=r.siblings(".page-content").eq(0)).length&&(i=r.parents(".page").eq(0).find(".page-content").eq(0)),r[0].f7ListIndex=o,Utils.extend(o,{app:t,$el:r,el:r&&r[0],$ul:s,ul:s&&s[0],$listEl:n,listEl:n&&n[0],$pageContentEl:i,pageContentEl:i&&i[0],indexes:a.indexes,height:0,skipRate:0}),o.useModules();var d,u,h,f,v,m={},g=null;function b(e){var t=s.children();t.length&&(h=t[0].getBoundingClientRect().top,f=t[t.length-1].getBoundingClientRect().top+t[0].offsetHeight,m.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,m.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,d=!0,u=!1,g=null)}function y(e){if(d){!u&&o.params.label&&(v=$('<span class="list-index-label"></span>'),r.append(v)),u=!0;var t="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;e.preventDefault();var a=(t-h)/(f-h);a=Math.min(Math.max(a,0),1);var n=Math.round((o.indexes.length-1)*a),i=o.indexes[n],s=f-h,l=(o.height-s)/2+(1-a)*s;n!==g&&(o.params.label&&v.html(i).transform("translateY(-"+l+"px)"),o.$listEl&&o.params.scrollList&&o.scrollListToIndex(i,n)),g=n,o.$el.trigger("listindex:select",o),o.emit("local::select listIndexSelect",o,i,n)}}function w(){d&&(d=!1,u=!1,o.params.label&&(v&&v.remove(),v=void 0))}var C=!!t.support.passiveListener&&{passive:!0};return o.attachEvents=function(){r.parents(".tab").on("tab:show",p),r.parents(".page").on("page:reinit",p),r.parents(".panel").on("panel:open",p),r.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast").on("modal:open",p),t.on("resize",p),r.on("click",c),r.on(t.touchEvents.start,b,C),t.on("touchmove:active",y),t.on("touchend:passive",w)},o.detachEvents=function(){r.parents(".tab").off("tab:show",p),r.parents(".page").off("page:reinit",p),r.parents(".panel").off("panel:open",p),r.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast").off("modal:open",p),t.off("resize",p),r.off("click",c),r.off(t.touchEvents.start,b,C),t.off("touchmove:active",y),t.off("touchend:passive",w)},o.init(),o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.scrollListToIndex=function(e,t){var a,r=this.$listEl,n=this.$pageContentEl;if(!r||!n||0===n.length)return this;if(r.find(".list-group-title, .item-divider").each(function(t,r){if(!a){var n=$(r);n.text()===e&&(a=n)}}),!a||0===a.length)return this;var i=a.parent().offset().top,s=parseInt(n.css("padding-top"),10),o=n[0].scrollTop,l=a.offset().top;return i<=s?n.scrollTop(i+o-s):n.scrollTop(l+o-s),this},t.prototype.renderSkipPlaceholder=function(){return this.params.renderSkipPlaceholder.call(this)},t.prototype.renderItem=function(e,t){return this.params.renderItem.call(this,e,t)},t.prototype.render=function(){var e,t=this,a=t.$ul,r=t.indexes,n=t.skipRate,i=r.map(function(a,r){if(r%n!=0&&n>0)return e=!0,"";var i=t.renderItem(a,r);return e&&(i=t.renderSkipPlaceholder()+i),e=!1,i}).join("");return a.html(i),t},t.prototype.calcSize=function(){var e=this.app,t=this.params,a=this.el,r=this.indexes,n=a.offsetHeight,i=t[e.theme+"ItemHeight"],s=Math.floor(n/i),o=r.length,l=0;return o>s&&(l=Math.ceil((2*o-1)/s)),this.height=n,this.skipRate=l,this},t.prototype.calcIndexes=function(){var e=this;return"auto"===e.params.indexes?(e.indexes=[],e.$listEl.find(".list-group-title, .item-divider").each(function(t,a){var r=$(a).text();e.indexes.indexOf(r)<0&&e.indexes.push(r)})):e.indexes=e.params.indexes,e},t.prototype.update=function(){return this.calcIndexes(),this.calcSize(),this.render(),this},t.prototype.init=function(){this.calcIndexes(),this.calcSize(),this.render(),this.attachEvents()},t.prototype.destroy=function(){var e=this;e.$el.trigger("listindex:beforedestroy",e),e.emit("local::beforeDestroy listIndexBeforeDestroy",e),e.detachEvents(),e.$el[0]&&(e.$el[0].f7ListIndex=null,delete e.$el[0].f7ListIndex),Utils.deleteProps(e),e=null},t}(Framework7Class),ListIndex$1={name:"listIndex",static:{ListIndex:ListIndex},create:function(){this.listIndex=ConstructorMethods({defaultSelector:".list-index",constructor:ListIndex,app:this,domProp:"f7ListIndex"})},on:{tabMounted:function(e){var t=this;$(e).find(".list-index-init").each(function(e,a){var r=Utils.extend($(a).dataset(),{el:a});t.listIndex.create(r)})},tabBeforeRemove:function(e){$(e).find(".list-index-init").each(function(e,t){t.f7ListIndex&&t.f7ListIndex.destroy()})},pageInit:function(e){var t=this;e.$el.find(".list-index-init").each(function(e,a){var r=Utils.extend($(a).dataset(),{el:a});t.listIndex.create(r)})},pageBeforeRemove:function(e){e.$el.find(".list-index-init").each(function(e,t){t.f7ListIndex&&t.f7ListIndex.destroy()})}},vnode:{"list-index-init":{insert:function(e){var t=e.elm,a=Utils.extend($(t).dataset(),{el:t});this.listIndex.create(a)},destroy:function(e){var t=e.elm;t.f7ListIndex&&t.f7ListIndex.destroy()}}}},Timeline={name:"timeline"},Tab={show:function(){for(var e,t,a,r=[],n=arguments.length;n--;)r[n]=arguments[n];var i,s,o,l,p=this;1===r.length&&r[0].constructor===Object?(i=r[0].tabEl,s=r[0].tabLinkEl,o=r[0].animate,l=r[0].tabRoute):(i=(e=r)[0],s=e[1],o=e[2],l=e[3],"boolean"==typeof r[1]&&(i=(t=r)[0],o=t[1],s=t[2],l=t[3],r.length>2&&s.constructor===Object&&(i=(a=r)[0],o=a[1],l=a[2],s=a[3]))),void 0===o&&(o=!0);var c,d=$(i);if(l&&d[0]&&(d[0].f7TabRoute=l),0===d.length||d.hasClass("tab-active"))return{$newTabEl:d,newTabEl:d[0]};s&&(c=$(s));var u=d.parent(".tabs");if(0===u.length)return{$newTabEl:d,newTabEl:d[0]};p.swipeout&&(p.swipeout.allowOpen=!0);var h=[];function f(){h.forEach(function(e){e()})}var v,m=!1;if(u.parent().hasClass("tabs-animated-wrap")){u.parent()[o?"removeClass":"addClass"]("not-animated");var g=parseFloat(u.css("transition-duration").replace(",","."));o&&g&&(u.transitionEnd(f),m=!0);var b=100*(p.rtl?d.index():-d.index());u.transform("translate3d("+b+"%,0,0)")}u.parent().hasClass("tabs-swipeable-wrap")&&p.swiper&&((v=u.parent()[0].swiper)&&v.activeIndex!==d.index()?(m=!0,v.once("slideChangeTransitionEnd",function(){f()}).slideTo(d.index(),o?void 0:0)):v&&v.animating&&(m=!0,v.once("slideChangeTransitionEnd",function(){f()})));var y=u.children(".tab-active");if(y.removeClass("tab-active"),(!v||v&&!v.animating||v&&l)&&(y.trigger("tab:hide"),p.emit("tabHide",y[0])),d.addClass("tab-active"),(!v||v&&!v.animating||v&&l)&&(d.trigger("tab:show"),p.emit("tabShow",d[0])),!c&&((!(c=$("string"==typeof i?'.tab-link[href="'+i+'"]':'.tab-link[href="#'+d.attr("id")+'"]'))||c&&0===c.length)&&$("[data-tab]").each(function(e,t){d.is($(t).attr("data-tab"))&&(c=$(t))}),l&&(!c||c&&0===c.length)&&0===(c=$('[data-route-tab-id="'+l.route.tab.id+'"]')).length&&(c=$('.tab-link[href="'+l.url+'"]')),c.length>1&&d.parents(".page").length&&(c=c.filter(function(e,t){return $(t).parents(".page")[0]===d.parents(".page")[0]}),"ios"===p.theme&&0===c.length&&l))){var w=d.parents(".page"),C=$(p.navbar.getElByPage(w));0===(c=C.find('[data-route-tab-id="'+l.route.tab.id+'"]')).length&&(c=C.find('.tab-link[href="'+l.url+'"]'))}if(c.length>0){var x;if(y&&y.length>0){var E=y.attr("id");E&&(!(x=$('.tab-link[href="#'+E+'"]'))||x&&0===x.length)&&(x=$('.tab-link[data-route-tab-id="'+E+'"]')),(!x||x&&0===x.length)&&$("[data-tab]").each(function(e,t){y.is($(t).attr("data-tab"))&&(x=$(t))}),(!x||x&&0===x.length)&&(x=c.siblings(".tab-link-active"))}else l&&(x=c.siblings(".tab-link-active"));if(x&&x.length>1&&y&&y.parents(".page").length&&(x=x.filter(function(e,t){return $(t).parents(".page")[0]===y.parents(".page")[0]})),x&&x.length>0&&x.removeClass("tab-link-active"),c&&c.length>0&&(c.addClass("tab-link-active"),"md"===p.theme&&p.toolbar)){var k=c.parents(".tabbar, .tabbar-labels");k.length>0&&p.toolbar.setHighlight(k)}}return{$newTabEl:d,newTabEl:d[0],$oldTabEl:y,oldTabEl:y[0],onTabsChanged:function(e){h.push(e)},animated:m}}},Tabs={name:"tabs",create:function(){Utils.extend(this,{tab:{show:Tab.show.bind(this)}})},clicks:{".tab-link":function(e,t){void 0===t&&(t={});(e.attr("href")&&0===e.attr("href").indexOf("#")||e.attr("data-tab"))&&this.tab.show({tabEl:t.tab||e.attr("href"),tabLinkEl:e,animate:t.animate})}}};function swipePanel(e){var t=e.app;Utils.extend(e,{swipeable:!0,swipeInitialized:!0});var a,r,n,i,s,o,l,p,c,d,u,h=t.params.panel,f=e.$el,v=e.$backdropEl,m=e.side,g=e.effect,b={},y=0;function w(o){if(e.swipeable&&t.panel.allowOpen&&(h.swipe||h.swipeOnlyClose)&&!r&&!($(".modal-in:not(.toast):not(.notification), .photo-browser-in").length>0)&&(a=t.panel["left"===m?"right":"left"]||{},(e.opened||!a.opened)&&(h.swipeCloseOpposite||h.swipeOnlyClose||!a.opened)&&(!o.target||"input"!==o.target.nodeName.toLowerCase()||"range"!==o.target.type)&&!($(o.target).closest(".range-slider, .tabs-swipeable-wrap, .calendar-months, .no-swipe-panel, .card-opened").length>0)&&(b.x="touchstart"===o.type?o.targetTouches[0].pageX:o.pageX,b.y="touchstart"===o.type?o.targetTouches[0].pageY:o.pageY,(!h.swipeOnlyClose||e.opened)&&("both"===h.swipe||!h.swipeCloseOpposite||h.swipe===m||e.opened)))){if(h.swipeActiveArea&&!e.opened){if("left"===m&&b.x>h.swipeActiveArea)return;if("right"===m&&b.x<t.width-h.swipeActiveArea)return}if(h.swipeCloseActiveAreaSide&&e.opened){if("left"===m&&b.x<f[0].offsetWidth-h.swipeCloseActiveAreaSide)return;if("right"===m&&b.x>t.width-f[0].offsetWidth+h.swipeCloseActiveAreaSide)return}y=0,u=$(e.getViewEl()),n=!1,r=!0,i=void 0,s=Utils.now(),d=void 0}}function C(a){if(r&&!((y+=1)<2))if(a.f7PreventSwipePanel||t.preventSwipePanelBySwipeBack||t.preventSwipePanel)r=!1;else{var w="touchmove"===a.type?a.targetTouches[0].pageX:a.pageX,C="touchmove"===a.type?a.targetTouches[0].pageY:a.pageY;if(void 0===i&&(i=!!(i||Math.abs(C-b.y)>Math.abs(w-b.x))),i)r=!1;else{if(!d){if(d=w>b.x?"to-right":"to-left","both"===h.swipe&&h.swipeActiveArea>0&&!e.opened){if("left"===m&&b.x>h.swipeActiveArea)return void(r=!1);if("right"===m&&b.x<t.width-h.swipeActiveArea)return void(r=!1)}if(f.hasClass("panel-visible-by-breakpoint"))return void(r=!1);if("left"===m&&"to-left"===d&&!f.hasClass("panel-active")||"right"===m&&"to-right"===d&&!f.hasClass("panel-active"))return void(r=!1)}var x=e.opened?0:-h.swipeThreshold;if("right"===m&&(x=-x),h.swipeNoFollow){var $,E=w-b.x,k=(new Date).getTime()-s;return!e.opened&&("left"===m&&E>-x||"right"===m&&-E>x)&&($=!0),e.opened&&("left"===m&&E<0||"right"===m&&E>0)&&($=!0),void($&&(k<300&&("to-left"===d&&("right"===m&&t.panel.open(m),"left"===m&&f.hasClass("panel-active")&&t.panel.close()),"to-right"===d&&("left"===m&&t.panel.open(m),"right"===m&&f.hasClass("panel-active")&&t.panel.close())),r=!1,n=!1))}n||(e.opened||(f.show(),v.show(),f.trigger("panel:swipeopen",e),e.emit("local::swipeOpen panelSwipeOpen",e)),c=f[0].offsetWidth,f.transition(0)),n=!0,a.preventDefault(),o=w-b.x+x,"right"===m?"cover"===g?((l=o+(e.opened?0:c))<0&&(l=0),l>c&&(l=c)):((l=o-(e.opened?c:0))>0&&(l=0),l<-c&&(l=-c)):((l=o+(e.opened?c:0))<0&&(l=0),l>c&&(l=c)),"reveal"===g?(u.transform("translate3d("+l+"px,0,0)").transition(0),v.transform("translate3d("+l+"px,0,0)").transition(0),f.trigger("panel:swipe",e,Math.abs(l/c)),e.emit("local::swipe panelSwipe",e,Math.abs(l/c))):("left"===m&&(l-=c),f.transform("translate3d("+l+"px,0,0)").transition(0),v.transition(0),p=1-Math.abs(l/c),v.css({opacity:p}),f.trigger("panel:swipe",e,Math.abs(l/c)),e.emit("local::swipe panelSwipe",e,Math.abs(l/c)))}}}function x(){if(!r||!n)return r=!1,void(n=!1);r=!1,n=!1;var t,a=(new Date).getTime()-s,i=0===l||Math.abs(l)===c,p=h.swipeThreshold||0;if("swap"===(t=e.opened?"cover"===g?0===l?"reset":a<300&&Math.abs(l)>0?"swap":a>=300&&Math.abs(l)<c/2?"reset":"swap":l===-c?"reset":a<300&&Math.abs(l)>=0||a>=300&&Math.abs(l)<=c/2?"left"===m&&l===c?"reset":"swap":"reset":Math.abs(o)<p?"reset":"cover"===g?0===l?"swap":a<300&&Math.abs(l)>0?"swap":a>=300&&Math.abs(l)<c/2?"swap":"reset":0===l?"reset":a<300&&Math.abs(l)>0||a>=300&&Math.abs(l)>=c/2?"swap":"reset")&&(e.opened?e.close(!i):e.open(!i)),"reset"===t&&!e.opened)if(i)f.css({display:""});else{var d="reveal"===g?u:f;$("html").addClass("with-panel-transitioning"),d.transitionEnd(function(){f.hasClass("panel-active")||(f.css({display:""}),$("html").removeClass("with-panel-transitioning"))})}"reveal"===g&&Utils.nextFrame(function(){u.transition(""),u.transform("")}),f.transition("").transform(""),v.css({display:""}).transform("").transition("").css("opacity","")}t.on("touchstart:passive",w),t.on("touchmove:active",C),t.on("touchend:passive",x),e.on("panelDestroy",function(){t.off("touchstart:passive",w),t.off("touchmove:active",C),t.off("touchend:passive",x)})}var Panel=function(e){function t(t,a){var r;void 0===a&&(a={}),e.call(this,a,[t]);var n=a.el;!n&&a.content&&(n=a.content);var i=$(n);if(0===i.length)return this;if(i[0].f7Panel)return i[0].f7Panel;i[0].f7Panel=this;var s=a.opened,o=a.side,l=a.effect;if(void 0===s&&(s=i.hasClass("panel-active")),void 0===o&&(o=i.hasClass("panel-left")?"left":"right"),void 0===l&&(l=i.hasClass("panel-cover")?"cover":"reveal"),t.panel[o])throw new Error("Framework7: Can't create panel; app already has a "+o+" panel!");Utils.extend(t.panel,((r={})[o]=this,r));var p=$(".panel-backdrop");return 0===p.length&&(p=$('<div class="panel-backdrop"></div>')).insertBefore(i),Utils.extend(this,{app:t,side:o,effect:l,$el:i,el:i[0],opened:s,$backdropEl:p,backdropEl:p[0]}),this.useModules(),this.init(),this}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.init=function(){var e=this.app;e.params.panel[this.side+"Breakpoint"]&&this.initBreakpoints(),(e.params.panel.swipe===this.side||"both"===e.params.panel.swipe||e.params.panel.swipe&&e.params.panel.swipe!==this.side&&e.params.panel.swipeCloseOpposite)&&this.initSwipePanel()},t.prototype.getViewEl=function(){var e=this.app;return e.root.children(".views").length>0?e.root.children(".views")[0]:e.root.children(".view")[0]},t.prototype.setBreakpoint=function(){var e,t,a,r=this.app,n=this.side,i=this.$el,s=$(this.getViewEl()),o=r.params.panel[n+"Breakpoint"],l=i.hasClass("panel-visible-by-breakpoint");r.width>=o?l?s.css(((t={})["margin-"+n]=i.width()+"px",t)):($("html").removeClass("with-panel-"+n+"-reveal with-panel-"+n+"-cover with-panel"),i.css("display","").addClass("panel-visible-by-breakpoint").removeClass("panel-active"),this.onOpen(),this.onOpened(),s.css(((e={})["margin-"+n]=i.width()+"px",e)),r.allowPanelOpen=!0,r.emit("local::breakpoint panelBreakpoint"),this.$el.trigger("panel:breakpoint",this)):l&&(i.css("display","").removeClass("panel-visible-by-breakpoint panel-active"),this.onClose(),this.onClosed(),s.css(((a={})["margin-"+n]="",a)),r.emit("local::breakpoint panelBreakpoint"),this.$el.trigger("panel:breakpoint",this))},t.prototype.initBreakpoints=function(){var e=this,t=e.app;return e.resizeHandler=function(){e.setBreakpoint()},t.params.panel[e.side+"Breakpoint"]&&t.on("resize",e.resizeHandler),e.setBreakpoint(),e},t.prototype.initSwipePanel=function(){swipePanel(this)},t.prototype.destroy=function(){var e,t=this,a=t.app;if(t.$el){if(t.emit("local::beforeDestroy panelBeforeDestroy",t),t.$el.trigger("panel:beforedestroy",t),t.resizeHandler&&a.off("resize",t.resizeHandler),t.$el.hasClass("panel-visible-by-breakpoint")){var r=$(t.getViewEl());t.$el.css("display","").removeClass("panel-visible-by-breakpoint panel-active"),r.css(((e={})["margin-"+t.side]="",e)),a.emit("local::breakpoint panelBreakpoint"),t.$el.trigger("panel:breakpoint",t)}t.$el.trigger("panel:destroy",t),t.emit("local::destroy panelDestroy"),delete a.panel[t.side],t.el&&(t.el.f7Panel=null,delete t.el.f7Panel),Utils.deleteProps(t),t=null}},t.prototype.open=function(e){void 0===e&&(e=!0);var t=this,a=t.app;if(!a.panel.allowOpen)return!1;var r=t.side,n=t.effect,i=t.$el,s=t.$backdropEl,o=t.opened,l=i.parent(),p=i.parents(document).length>0;if(!l.is(a.root)||i.prevAll(".views, .view").length){var c=a.root.children(".panel, .views, .view").eq(0),d=a.root.children(".statusbar").eq(0);c.length?i.insertBefore(c):d.length?i.insertAfter(c):a.root.prepend(i),s&&s.length&&(!s.parent().is(a.root)&&0===s.nextAll(".panel").length||s.parent().is(a.root)&&0===s.nextAll(".panel").length)&&s.insertBefore(i),t.once("panelClosed",function(){p?l.append(i):i.remove()})}if(o||i.hasClass("panel-visible-by-breakpoint")||i.hasClass("panel-active"))return!1;a.panel.close("left"===r?"right":"left",e),a.panel.allowOpen=!1,i[e?"removeClass":"addClass"]("not-animated"),i.css({display:"block"}).addClass("panel-active"),s[e?"removeClass":"addClass"]("not-animated"),s.show(),t._clientLeft=i[0].clientLeft,$("html").addClass("with-panel with-panel-"+r+"-"+n),t.onOpen();var u="reveal"===n?i.nextAll(".view, .views").eq(0):i;return e?function e(){u.transitionEnd(function(a){$(a.target).is(u)?i.hasClass("panel-active")?(t.onOpened(),s.css({display:""})):(t.onClosed(),s.css({display:""})):e()})}():(t.onOpened(),s.css({display:""})),!0},t.prototype.close=function(e){void 0===e&&(e=!0);var t=this,a=t.app,r=t.side,n=t.effect,i=t.$el,s=t.$backdropEl;if(!t.opened||i.hasClass("panel-visible-by-breakpoint")||!i.hasClass("panel-active"))return!1;i[e?"removeClass":"addClass"]("not-animated"),i.removeClass("panel-active"),s[e?"removeClass":"addClass"]("not-animated");var o="reveal"===n?i.nextAll(".view, .views").eq(0):i;return t.onClose(),a.panel.allowOpen=!1,e?(o.transitionEnd(function(){i.hasClass("panel-active")||(i.css({display:""}),$("html").removeClass("with-panel-transitioning"),t.onClosed())}),$("html").removeClass("with-panel with-panel-"+r+"-"+n).addClass("with-panel-transitioning")):(i.css({display:""}),i.removeClass("not-animated"),$("html").removeClass("with-panel with-panel-transitioning with-panel-"+r+"-"+n),t.onClosed()),!0},t.prototype.toggle=function(e){void 0===e&&(e=!0);this.opened?this.close(e):this.open(e)},t.prototype.onOpen=function(){this.opened=!0,this.$el.trigger("panel:open",this),this.emit("local::open panelOpen",this)},t.prototype.onOpened=function(){this.app.panel.allowOpen=!0,this.$el.trigger("panel:opened",this),this.emit("local::opened panelOpened",this)},t.prototype.onClose=function(){this.opened=!1,this.$el.addClass("panel-closing"),this.$el.trigger("panel:close",this),this.emit("local::close panelClose",this)},t.prototype.onClosed=function(){this.app.panel.allowOpen=!0,this.$el.removeClass("panel-closing"),this.$el.trigger("panel:closed",this),this.emit("local::closed panelClosed",this)},t}(Framework7Class),Panel$1={name:"panel",params:{panel:{leftBreakpoint:0,rightBreakpoint:0,swipe:void 0,swipeActiveArea:0,swipeCloseActiveAreaSide:0,swipeCloseOpposite:!0,swipeOnlyClose:!1,swipeNoFollow:!1,swipeThreshold:0,closeByBackdropClick:!0}},static:{Panel:Panel},instance:{panel:{allowOpen:!0}},create:function(){var e=this;Utils.extend(e.panel,{disableSwipe:function(t){var a;void 0===t&&(t="both");var r=[];"string"==typeof t?"both"===t?(a="both",r=[e.panel.left,e.panel.right]):(a=t,r.push(e.panel[a])):r=[t],r.forEach(function(e){e&&Utils.extend(e,{swipeable:!1})})},enableSwipe:function(t){void 0===t&&(t="both");var a,r=[];"string"==typeof t?(a=t,"left"===e.params.panel.swipe&&"right"===a||"right"===e.params.panel.swipe&&"left"===a||"both"===a?(a="both",e.params.panel.swipe=a,r=[e.panel.left,e.panel.right]):(e.params.panel.swipe=a,r.push(e.panel[a]))):t&&r.push(t),r.length&&r.forEach(function(e){e&&(e.swipeInitialized?Utils.extend(e,{swipeable:!0}):e.initSwipePanel())})},create:function(t){return new Panel(e,t)},open:function(t,a){var r=t;if(!r){if($(".panel").length>1)return!1;r=$(".panel").hasClass("panel-left")?"left":"right"}if(!r)return!1;if(e.panel[r])return e.panel[r].open(a);var n=$(".panel-"+r);return n.length>0&&e.panel.create({el:n}).open(a)},close:function(t,a){var r,n;return n?r=$(".panel-"+(n=t)):n=(r=$(".panel.panel-active")).hasClass("panel-left")?"left":"right",!!n&&(e.panel[n]?e.panel[n].close(a):r.length>0&&e.panel.create({el:r}).close(a))},toggle:function(t,a){var r,n=t;if(t)r=$(".panel-"+(n=t));else if($(".panel.panel-active").length)n=(r=$(".panel.panel-active")).hasClass("panel-left")?"left":"right";else{if($(".panel").length>1)return!1;n=$(".panel").hasClass("panel-left")?"left":"right",r=$(".panel-"+n)}return!!n&&(e.panel[n]?e.panel[n].toggle(a):r.length>0&&e.panel.create({el:r}).toggle(a))},get:function(t){var a=t;if(!a){if($(".panel").length>1)return;a=$(".panel").hasClass("panel-left")?"left":"right"}if(a){if(e.panel[a])return e.panel[a];var r=$(".panel-"+a);return r.length>0?e.panel.create({el:r}):void 0}}})},on:{init:function(){var e=this;$(".panel").each(function(t,a){var r=$(a).hasClass("panel-left")?"left":"right";e.panel[r]=e.panel.create({el:a,side:r})})}},clicks:{".panel-open":function(e,t){void 0===t&&(t={});var a="left";("right"===t.panel||1===$(".panel").length&&$(".panel").hasClass("panel-right"))&&(a="right"),this.panel.open(a,t.animate)},".panel-close":function(e,t){void 0===t&&(t={});var a=t.panel;this.panel.close(a,t.animate)},".panel-toggle":function(e,t){void 0===t&&(t={});var a=t.panel;this.panel.toggle(a,t.animate)},".panel-backdrop":function(){var e=$(".panel-active"),t=e[0]&&e[0].f7Panel;e.trigger("panel:backdrop-click"),t&&t.emit("backdropClick",t),this.emit("panelBackdropClick",t||e[0]),this.params.panel.closeByBackdropClick&&this.panel.close()}}},CardExpandable={open:function(e,t){var a;void 0===e&&(e=".card-expandable"),void 0===t&&(t=!0);var r=this;if(!$(".card-opened").length){var n=$(e).eq(0);if(n&&n.length&&!(n.hasClass("card-opened")||n.hasClass("card-opening")||n.hasClass("card-closing"))){var i,s=n.parents(".page").eq(0);if(s.length)if(n.trigger("card:beforeopen",{prevent:q}),r.emit("cardBeforeOpen",n[0],q),!i){var o,l,p;n.attr("data-backdrop-el")&&(o=$(n.attr("data-backdrop-el"))),!o&&r.params.card.backrop&&((o=n.parents(".page-content").find(".card-backdrop")).length||(o=$('<div class="card-backdrop"></div>'),n.parents(".page-content").append(o))),r.params.card.hideNavbarOnOpen&&((l=s.children(".navbar")).length||s[0].f7Page&&(l=s[0].f7Page.$navbarEl)),r.params.card.hideToolbarOnOpen&&((p=s.children(".toolbar")).length||(p=s.parents(".view").children(".toolbar")),p.length||(p=s.parents(".views").children(".toolbar")));var c,d=n.css("transform");d&&d.match(/[2-9]/)&&(c=!0);var u=n.children(".card-content"),h=$(document.createElement("div")).addClass("card-expandable-size");n.append(h);var f,v,m=n[0].offsetWidth,g=n[0].offsetHeight,b=s[0].offsetWidth,y=s[0].offsetHeight,w=h[0].offsetWidth||b,C=h[0].offsetHeight||y,x=w/m,E=C/g,k=n.offset(),S=s.offset();if(k.left-=S.left,k.top-=S.top,c){var T=d.replace(/matrix\(|\)/g,"").split(",").map(function(e){return e.trim()});if(T&&T.length>1){var M=parseFloat(T[0]);f=k.left-m*(1-M)/2,v=k.top-s.offset().top-g*(1-M)/2,r.rtl&&(f-=n[0].scrollLeft)}else f=n[0].offsetLeft,v=n[0].offsetTop-n.parents(".page-content")[0].scrollTop}else f=k.left,v=k.top-s.offset().top,r.rtl&&(f-=n[0].scrollLeft);v-=(y-C)/2;var P=w-m-(f-=(b-w)/2);r.rtl&&(f=(a=[P,f])[0],P=a[1]);var O,D,I,B,R,L,A,z,H,U,N,F=C-g-v,V=(P-f)/2,j=(F-v)/2;r.params.card.hideNavbarOnOpen&&l&&l.length&&r.navbar.hide(l,t),r.params.card.hideToolbarOnOpen&&p&&p.length&&r.toolbar.hide(p,t),o&&o.removeClass("card-backdrop-out").addClass("card-backdrop-in"),n.removeClass("card-transitioning"),t&&n.addClass("card-opening"),n.trigger("card:open"),r.emit("cardOpen",n[0]),u.css({width:w+"px",height:C+"px"}).transform("translate3d("+(r.rtl?f+V:-f-V)+"px, 0px, 0) scale("+1/x+", "+1/E+")"),n.transform("translate3d("+V+"px, "+j+"px, 0) scale("+x+", "+E+")"),t?n.transitionEnd(function(){Y()}):Y(),s.addClass("page-with-card-opened"),n[0].detachEventHandlers=function(){r.off("resize",_),Support.touch&&r.params.card.swipeToClose&&(r.off("touchstart:passive",W),r.off("touchmove:active",X),r.off("touchend:passive",G))},r.on("resize",_),Support.touch&&r.params.card.swipeToClose&&(r.on("touchstart:passive",W),r.on("touchmove:active",X),r.on("touchend:passive",G))}}}function q(){i=!0}function Y(){n.addClass("card-opened"),n.removeClass("card-opening"),n.trigger("card:opened"),r.emit("cardOpened",n[0])}function _(){var e;n.removeClass("card-transitioning"),m=n[0].offsetWidth,g=n[0].offsetHeight,b=s[0].offsetWidth,y=s[0].offsetHeight,w=h[0].offsetWidth||b,C=h[0].offsetHeight||y,x=w/m,E=C/g,n.transform("translate3d(0px, 0px, 0) scale(1)"),k=n.offset(),S=s.offset(),k.left-=S.left,k.top-=S.top,f=k.left-(b-w)/2,r.rtl&&(f-=n[0].scrollLeft),v=k.top-(y-C)/2,P=w-m-f,F=C-g-v,r.rtl&&(f=(e=[P,f])[0],P=e[1]),V=(P-f)/2,j=(F-v)/2,n.transform("translate3d("+V+"px, "+j+"px, 0) scale("+x+", "+E+")"),u.css({width:w+"px",height:C+"px"}).transform("translate3d("+(r.rtl?f+V:-f-V)+"px, 0px, 0) scale("+1/x+", "+1/E+")")}function W(e){$(e.target).closest(n).length&&n.hasClass("card-opened")&&(O=u.scrollTop(),D=!0,B=e.targetTouches[0].pageX,R=e.targetTouches[0].pageY,z=void 0,U=!1,N=!1)}function X(e){if(D){if(L=e.targetTouches[0].pageX,A=e.targetTouches[0].pageY,void 0===z&&(z=!!(z||Math.abs(A-R)>Math.abs(L-B))),N||U||(!z&&e.targetTouches[0].clientX<=50?N=!0:U=!0),!N&&!U||U&&0!==O)return D=!0,void(I=!0);I||n.removeClass("card-transitioning"),I=!0,((H=U?Math.max((A-R)/150,0):Math.max((L-B)/(m/2),0))>0&&U||N)&&(U&&r.device.ios&&(u.css("-webkit-overflow-scrolling","auto"),u.scrollTop(0)),e.preventDefault()),H>1&&(H=Math.pow(H,.3)),H>(U?1.3:1.1)?(D=!1,I=!1,r.card.close(n)):n.transform("translate3d("+V+"px, "+j+"px, 0) scale("+x*(1-.2*H)+", "+E*(1-.2*H)+")")}}function G(){D&&I&&(D=!1,I=!1,r.device.ios&&u.css("-webkit-overflow-scrolling",""),H>=.8?r.card.close(n):n.addClass("card-transitioning").transform("translate3d("+V+"px, "+j+"px, 0) scale("+x+", "+E+")"))}},close:function(e,t){void 0===e&&(e=".card-expandable.card-opened"),void 0===t&&(t=!0);var a=this,r=$(e).eq(0);if(r&&r.length&&r.hasClass("card-opened")&&!r.hasClass("card-opening")&&!r.hasClass("card-closing")){var n,i,s,o=r.children(".card-content"),l=r.parents(".page").eq(0);if(l.length)r.attr("data-backdrop-el")&&(s=$(r.attr("data-backdrop-el"))),a.params.card.backrop&&(s=r.parents(".page-content").find(".card-backdrop")),a.params.card.hideNavbarOnOpen&&((n=l.children(".navbar")).length||l[0].f7Page&&(n=l[0].f7Page.$navbarEl),n&&n.length&&a.navbar.show(n,t)),a.params.card.hideToolbarOnOpen&&((i=l.children(".toolbar")).length||(i=l.parents(".view").children(".toolbar")),i.length||(i=l.parents(".views").children(".toolbar")),i&&i.length&&a.toolbar.show(i,t)),l.removeClass("page-with-card-opened"),s&&s.length&&s.removeClass("card-backdrop-in").addClass("card-backdrop-out"),r.removeClass("card-opened card-transitioning"),t?r.addClass("card-closing"):r.addClass("card-no-transition"),r.transform(""),r.trigger("card:close"),a.emit("cardClose",r[0]),o.css({width:"",height:""}).transform("").scrollTop(0,t?300:0),t?o.transitionEnd(function(){p()}):p(),r[0].detachEventHandlers&&(r[0].detachEventHandlers(),delete r[0].detachEventHandlers)}function p(){r.removeClass("card-closing card-no-transition"),r.trigger("card:closed"),r.find(".card-expandable-size").remove(),a.emit("cardClosed",r[0])}},toggle:function(e,t){void 0===e&&(e=".card-expandable");var a=$(e).eq(0);a.length&&(a.hasClass("card-opened")?this.card.close(a,t):this.card.open(a,t))}},Card={name:"card",params:{card:{hideNavbarOnOpen:!0,hideToolbarOnOpen:!0,swipeToClose:!0,closeByBackdropClick:!0,backrop:!0}},create:function(){Utils.extend(this,{card:{open:CardExpandable.open.bind(this),close:CardExpandable.close.bind(this),toggle:CardExpandable.toggle.bind(this)}})},on:{pageBeforeIn:function(e){if(this.params.card.hideNavbarOnOpen&&e.navbarEl&&e.$el.find(".card-opened.card-expandable").length&&this.navbar.hide(e.navbarEl),this.params.card.hideToolbarOnOpen&&e.$el.find(".card-opened.card-expandable").length){var t=e.$el.children(".toolbar");t.length||(t=e.$el.parents(".view").children(".toolbar")),t.length||(t=e.$el.parents(".views").children(".toolbar")),t&&t.length&&this.toolbar.hide(t)}}},clicks:{".card-close":function(e,t){this.card.close(t.card)},".card-open":function(e,t){this.card.open(t.card)},".card-expandable":function(e,t,a){e.hasClass("card-opened")||e.hasClass("card-opening")||e.hasClass("card-closing")||$(a.target).closest(".card-prevent-open").length||this.card.open(e)},".card-backdrop-in":function(){var e=!1;this.params.card.closeByBackdropClick&&(e=!0);var t=$(".card-opened");t.length&&("true"===t.attr("data-close-on-backdrop-click")?e=!0:"false"===t.attr("data-close-on-backdrop-click")&&(e=!1),e&&this.card.close(t))}}},Chip={name:"chip"},FormData$1={store:function(e,t){var a=e,r=$(e);r.length&&r.is("form")&&r.attr("id")&&(a=r.attr("id")),this.form.data["form-"+a]=t;try{win.localStorage["f7form-"+a]=JSON.stringify(t)}catch(e){throw e}},get:function(e){var t=e,a=$(e);a.length&&a.is("form")&&a.attr("id")&&(t=a.attr("id"));try{if(win.localStorage["f7form-"+t])return JSON.parse(win.localStorage["f7form-"+t])}catch(e){throw e}if(this.form.data["form-"+t])return this.form.data["form-"+t]},remove:function(e){var t=e,a=$(e);a.length&&a.is("form")&&a.attr("id")&&(t=a.attr("id")),this.form.data["form-"+t]&&(this.form.data["form-"+t]="",delete this.form.data["form-"+t]);try{win.localStorage["f7form-"+t]&&(win.localStorage["f7form-"+t]="",win.localStorage.removeItem("f7form-"+t))}catch(e){throw e}}},FormStorage={init:function(e){var t=this,a=$(e),r=a.attr("id");if(r){var n=t.form.getFormData(r);n&&t.form.fillFromData(a,n),a.on("change submit",function(){var e=t.form.convertToData(a);e&&(t.form.storeFormData(r,e),a.trigger("form:storedata",e),t.emit("formStoreData",a[0],e))})}},destroy:function(e){$(e).off("change submit")}};function formToData(e){var t=$(e).eq(0);if(0!==t.length){var a={},r=["submit","image","button","file"],n=[];return t.find("input, select, textarea").each(function(e,i){var s=$(i);if(!s.hasClass("ignore-store-data")&&!s.hasClass("no-store-data")){var o=s.attr("name"),l=s.attr("type"),p=i.nodeName.toLowerCase();if(!(r.indexOf(l)>=0)&&!(n.indexOf(o)>=0)&&o)if("select"===p&&s.prop("multiple"))n.push(o),a[o]=[],t.find('select[name="'+o+'"] option').each(function(e,t){t.selected&&a[o].push(t.value)});else switch(l){case"checkbox":n.push(o),a[o]=[],t.find('input[name="'+o+'"]').each(function(e,t){t.checked&&a[o].push(t.value)});break;case"radio":n.push(o),t.find('input[name="'+o+'"]').each(function(e,t){t.checked&&(a[o]=t.value)});break;default:a[o]=s.val()}}}),t.trigger("form:todata",a),this.emit("formToData",t[0],a),a}}function formFromData(e,t){var a=$(e).eq(0);if(a.length){var r=t,n=a.attr("id");if(!r&&n&&(r=this.form.getFormData(n)),r){var i=["submit","image","button","file"],s=[];a.find("input, select, textarea").each(function(e,t){var n=$(t);if(!n.hasClass("ignore-store-data")&&!n.hasClass("no-store-data")){var o=n.attr("name"),l=n.attr("type"),p=t.nodeName.toLowerCase();if(void 0!==r[o]&&null!==r[o]&&!(i.indexOf(l)>=0)&&!(s.indexOf(o)>=0)&&o){if("select"===p&&n.prop("multiple"))s.push(o),a.find('select[name="'+o+'"] option').each(function(e,t){var a=t;r[o].indexOf(t.value)>=0?a.selected=!0:a.selected=!1});else switch(l){case"checkbox":s.push(o),a.find('input[name="'+o+'"]').each(function(e,t){var a=t;r[o].indexOf(t.value)>=0?a.checked=!0:a.checked=!1});break;case"radio":s.push(o),a.find('input[name="'+o+'"]').each(function(e,t){var a=t;r[o]===t.value?a.checked=!0:a.checked=!1});break;default:n.val(r[o])}"select"!==p&&"input"!==p&&"textarea"!==p||n.trigger("change","fromdata")}}}),a.trigger("form:fromdata",r),this.emit("formFromData",a[0],r)}}}function initAjaxForm(){var e=this;$(doc).on("submit change","form.form-ajax-submit, form.form-ajax-submit-onchange",function(t,a){var r=$(this);if(("change"!==t.type||r.hasClass("form-ajax-submit-onchange"))&&("submit"===t.type&&t.preventDefault(),"change"!==t.type||"fromdata"!==a)){var n,i=(r.attr("method")||"GET").toUpperCase(),s=r.prop("enctype")||r.attr("enctype"),o=r.attr("action");o&&(n="POST"===i?"application/x-www-form-urlencoded"===s?e.form.convertToData(r[0]):new win.FormData(r[0]):Utils.serializeObject(e.form.convertToData(r[0])),e.request({method:i,url:o,contentType:s,data:n,beforeSend:function(t){r.trigger("formajax:beforesend",{data:n,xhr:t}),e.emit("formAjaxBeforeSend",r[0],n,t)},error:function(t){r.trigger("formajax:error",{data:n,xhr:t}),e.emit("formAjaxError",r[0],n,t)},complete:function(t){r.trigger("formajax:complete",{data:n,xhr:t}),e.emit("formAjaxComplete",r[0],n,t)},success:function(t,a,i){r.trigger("formajax:success",{data:n,xhr:i}),e.emit("formAjaxSuccess",r[0],n,i)}}))}})}var Form={name:"form",create:function(){Utils.extend(this,{form:{data:{},storeFormData:FormData$1.store.bind(this),getFormData:FormData$1.get.bind(this),removeFormData:FormData$1.remove.bind(this),convertToData:formToData.bind(this),fillFromData:formFromData.bind(this),storage:{init:FormStorage.init.bind(this),destroy:FormStorage.destroy.bind(this)}}})},on:{init:function(){initAjaxForm.call(this)},tabBeforeRemove:function(e){var t=this;$(e).find(".form-store-data").each(function(e,a){t.form.storage.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".form-store-data").each(function(e,a){t.form.storage.init(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".form-store-data").each(function(e,a){t.form.storage.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".form-store-data").each(function(e,a){t.form.storage.init(a)})}}},Input={ignoreTypes:["checkbox","button","submit","range","radio","image"],createTextareaResizableShadow:function(){var e=$(doc.createElement("textarea"));e.addClass("textarea-resizable-shadow"),e.prop({disabled:!0,readonly:!0}),Input.textareaResizableShadow=e},textareaResizableShadow:void 0,resizeTextarea:function(e){var t=$(e);Input.textareaResizableShadow||Input.createTextareaResizableShadow();var a=Input.textareaResizableShadow;if(t.length&&t.hasClass("resizable")){0===Input.textareaResizableShadow.parents().length&&this.root.append(a);var r=win.getComputedStyle(t[0]);"padding-top padding-bottom padding-left padding-right margin-left margin-right margin-top margin-bottom width font-size font-family font-style font-weight line-height font-variant text-transform letter-spacing border box-sizing display".split(" ").forEach(function(e){var t=r[e];"font-size line-height letter-spacing width".split(" ").indexOf(e)>=0&&(t=t.replace(",",".")),a.css(e,t)});var n=t[0].clientHeight;a.val("");var i=a[0].scrollHeight;a.val(t.val()),a.css("height",0);var s=a[0].scrollHeight;n!==s&&(s>i?(t.css("height",s+"px"),t.trigger("textarea:resize",{initialHeight:i,currentHeight:n,scrollHeight:s})):s<n&&(t.css("height",""),t.trigger("textarea:resize",{initialHeight:i,currentHeight:n,scrollHeight:s})))}},validate:function(e){var t=$(e);if(t.length){var a=t.parents(".item-input"),r=t.parents(".input"),n=t[0].validity,i=t.dataset().errorMessage||t[0].validationMessage||"";if(n)if(n.valid)a.removeClass("item-input-invalid item-input-with-error-message"),r.removeClass("input-invalid input-with-error-message"),t.removeClass("input-invalid");else{var s=t.nextAll(".item-input-error-message, .input-error-message");i&&(0===s.length&&(s=$('<div class="'+(r.length?"input-error-message":"item-input-error-message")+'"></div>')).insertAfter(t),s.text(i)),s.length>0&&(a.addClass("item-input-with-error-message"),r.addClass("input-with-error-message")),a.addClass("item-input-invalid"),r.addClass("input-invalid"),t.addClass("input-invalid")}}},validateInputs:function(e){var t=this;$(e).find("input, textarea, select").each(function(e,a){t.input.validate(a)})},focus:function(e){var t=$(e),a=t.attr("type");Input.ignoreTypes.indexOf(a)>=0||(t.parents(".item-input").addClass("item-input-focused"),t.parents(".input").addClass("input-focused"),t.addClass("input-focused"))},blur:function(e){var t=$(e);t.parents(".item-input").removeClass("item-input-focused"),t.parents(".input").removeClass("input-focused"),t.removeClass("input-focused")},checkEmptyState:function(e){var t=$(e);if(t.is("input, select, textarea")||(t=t.find("input, select, textarea").eq(0)),t.length){var a=t.val(),r=t.parents(".item-input"),n=t.parents(".input");a&&"string"==typeof a&&""!==a.trim()||Array.isArray(a)&&a.length>0?(r.addClass("item-input-with-value"),n.addClass("input-with-value"),t.addClass("input-with-value"),t.trigger("input:notempty")):(r.removeClass("item-input-with-value"),n.removeClass("input-with-value"),t.removeClass("input-with-value"),t.trigger("input:empty"))}},scrollIntoView:function(e,t,a,r){void 0===t&&(t=0);var n=$(e),i=n.parents(".page-content, .panel").eq(0);if(!i.length)return!1;var s=i[0].offsetHeight,o=i[0].scrollTop,l=parseInt(i.css("padding-top"),10),p=parseInt(i.css("padding-bottom"),10),c=i.offset().top-o,d=n.offset().top-c,u=d+o-l,h=d+o-s+p+n[0].offsetHeight,f=u+(h-u)/2;return o>u?(i.scrollTop(a?f:u,t),!0):o<h?(i.scrollTop(a?f:h,t),!0):(r&&i.scrollTop(a?f:h,t),!1)},init:function(){var e=this;Input.createTextareaResizableShadow(),$(doc).on("click",".input-clear-button",function(){var e=$(this).siblings("input, textarea").eq(0),t=e.val();e.val("").trigger("input change").focus().trigger("input:clear",t)}),$(doc).on("change input","input, textarea, select",function(){var t=$(this),a=t.attr("type"),r=t[0].nodeName.toLowerCase();Input.ignoreTypes.indexOf(a)>=0||(e.input.checkEmptyState(t),null!==t.attr("data-validate-on-blur")||!t.dataset().validate&&null===t.attr("validate")||e.input.validate(t),"textarea"===r&&t.hasClass("resizable")&&e.input.resizeTextarea(t))},!0),$(doc).on("focus","input, textarea, select",function(){var t=this;e.params.input.scrollIntoViewOnFocus&&(Device.android?$(win).once("resize",function(){doc&&doc.activeElement===t&&e.input.scrollIntoView(t,e.params.input.scrollIntoViewDuration,e.params.input.scrollIntoViewCentered,e.params.input.scrollIntoViewAlways)}):e.input.scrollIntoView(t,e.params.input.scrollIntoViewDuration,e.params.input.scrollIntoViewCentered,e.params.input.scrollIntoViewAlways)),e.input.focus(t)},!0),$(doc).on("blur","input, textarea, select",function(){var t=$(this),a=t[0].nodeName.toLowerCase();e.input.blur(t),(t.dataset().validate||null!==t.attr("validate")||null!==t.attr("data-validate-on-blur"))&&e.input.validate(t),"textarea"===a&&t.hasClass("resizable")&&Input.textareaResizableShadow&&Input.textareaResizableShadow.remove()},!0),$(doc).on("invalid","input, textarea, select",function(t){var a=$(this);null!==a.attr("data-validate-on-blur")||!a.dataset().validate&&null===a.attr("validate")||(t.preventDefault(),e.input.validate(a))},!0)}},Input$1={name:"input",params:{input:{scrollIntoViewOnFocus:Device.android,scrollIntoViewCentered:!1,scrollIntoViewDuration:0,scrollIntoViewAlways:!1}},create:function(){Utils.extend(this,{input:{scrollIntoView:Input.scrollIntoView.bind(this),focus:Input.focus.bind(this),blur:Input.blur.bind(this),validate:Input.validate.bind(this),validateInputs:Input.validateInputs.bind(this),checkEmptyState:Input.checkEmptyState.bind(this),resizeTextarea:Input.resizeTextarea.bind(this),init:Input.init.bind(this)}})},on:{init:function(){this.input.init()},tabMounted:function(e){var t=this,a=$(e);a.find(".item-input, .input").each(function(e,a){$(a).find("input, select, textarea").each(function(e,a){var r=$(a);Input.ignoreTypes.indexOf(r.attr("type"))>=0||t.input.checkEmptyState(r)})}),a.find("textarea.resizable").each(function(e,a){t.input.resizeTextarea(a)})},pageInit:function(e){var t=this,a=e.$el;a.find(".item-input, .input").each(function(e,a){$(a).find("input, select, textarea").each(function(e,a){var r=$(a);Input.ignoreTypes.indexOf(r.attr("type"))>=0||t.input.checkEmptyState(r)})}),a.find("textarea.resizable").each(function(e,a){t.input.resizeTextarea(a)})}}},Checkbox={name:"checkbox"},Radio={name:"radio"},Toggle=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n={};r.useModulesParams(n),r.params=Utils.extend(n,a);var i=r.params.el;if(!i)return r;var s=$(i);if(0===s.length)return r;if(s[0].f7Toggle)return s[0].f7Toggle;var o,l=s.children('input[type="checkbox"]');Utils.extend(r,{app:t,$el:s,el:s[0],$inputEl:l,inputEl:l[0],disabled:s.hasClass("disabled")||l.hasClass("disabled")||l.attr("disabled")||l[0].disabled}),Object.defineProperty(r,"checked",{enumerable:!0,configurable:!0,set:function(e){r&&void 0!==r.$inputEl&&r.checked!==e&&(l[0].checked=e,r.$inputEl.trigger("change"))},get:function(){return l[0].checked}}),s[0].f7Toggle=r;var p,c,d,u,h,f={};function v(e){o||r.disabled||(f.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,f.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,c=0,o=!0,p=void 0,u=Utils.now(),h=r.checked,d=s[0].offsetWidth,Utils.nextTick(function(){o&&s.addClass("toggle-active-state")}))}function m(e){if(o&&!r.disabled){var a,n="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,i="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,s=t.rtl?-1:1;if(void 0===p&&(p=!!(p||Math.abs(i-f.y)>Math.abs(n-f.x))),p)o=!1;else e.preventDefault(),(c=n-f.x)*s<0&&Math.abs(c)>d/3&&h&&(a=!0),c*s>0&&Math.abs(c)>d/3&&!h&&(a=!0),a&&(f.x=n,r.checked=!h,h=!h)}}function g(){if(!o||r.disabled)return p&&s.removeClass("toggle-active-state"),void(o=!1);var e,a=t.rtl?-1:1;o=!1,s.removeClass("toggle-active-state"),Utils.now()-u<300&&(c*a<0&&h&&(e=!0),c*a>0&&!h&&(e=!0),e&&(r.checked=!h))}function b(){r.$el.trigger("toggle:change",r),r.emit("local::change toggleChange",r)}r.attachEvents=function(){if(Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.on(t.touchEvents.start,v,e),t.on("touchmove",m),t.on("touchend:passive",g)}r.$inputEl.on("change",b)},r.detachEvents=function(){if(Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.off(t.touchEvents.start,v,e),t.off("touchmove",m),t.off("touchend:passive",g)}r.$inputEl.off("change",b)},r.useModules(),r.init()}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.toggle=function(){this.checked=!this.checked},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.$el.trigger("toggle:beforedestroy",e),e.emit("local::beforeDestroy toggleBeforeDestroy",e),delete e.$el[0].f7Toggle,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Toggle$1={name:"toggle",create:function(){this.toggle=ConstructorMethods({defaultSelector:".toggle",constructor:Toggle,app:this,domProp:"f7Toggle"})},static:{Toggle:Toggle},on:{tabMounted:function(e){var t=this;$(e).find(".toggle-init").each(function(e,a){return t.toggle.create({el:a})})},tabBeforeRemove:function(e){$(e).find(".toggle-init").each(function(e,t){t.f7Toggle&&t.f7Toggle.destroy()})},pageInit:function(e){var t=this;e.$el.find(".toggle-init").each(function(e,a){return t.toggle.create({el:a})})},pageBeforeRemove:function(e){e.$el.find(".toggle-init").each(function(e,t){t.f7Toggle&&t.f7Toggle.destroy()})}},vnode:{"toggle-init":{insert:function(e){var t=e.elm;this.toggle.create({el:t})},destroy:function(e){var t=e.elm;t.f7Toggle&&t.f7Toggle.destroy()}}}},Range=function(e){function t(t,a){e.call(this,a,[t]);var r=this,n={el:null,inputEl:null,dual:!1,step:1,label:!1,min:0,max:100,value:0,draggableBar:!0,vertical:!1,verticalReversed:!1,formatLabel:null,scale:!1,scaleSteps:5,scaleSubSteps:0,formatScaleLabel:null};r.useModulesParams(n),r.params=Utils.extend(n,a);var i=r.params.el;if(!i)return r;var s=$(i);if(0===s.length)return r;if(s[0].f7Range)return s[0].f7Range;var o,l=s.dataset();"step min max value scaleSteps scaleSubSteps".split(" ").forEach(function(e){void 0===a[e]&&void 0!==l[e]&&(r.params[e]=parseFloat(l[e]))}),"dual label vertical verticalReversed scale".split(" ").forEach(function(e){void 0===a[e]&&void 0!==l[e]&&(r.params[e]=l[e])}),r.params.value||(void 0!==l.value&&(r.params.value=l.value),void 0!==l.valueLeft&&void 0!==l.valueRight&&(r.params.value=[parseFloat(l.valueLeft),parseFloat(l.valueRight)])),r.params.dual||(r.params.inputEl?o=$(r.params.inputEl):s.find('input[type="range"]').length&&(o=s.find('input[type="range"]').eq(0)));var p=r.params,c=p.dual,d=p.step,u=p.label,h=p.min,f=p.max,v=p.value,m=p.vertical,g=p.verticalReversed,b=p.scale,y=p.scaleSteps,w=p.scaleSubSteps;Utils.extend(r,{app:t,$el:s,el:s[0],$inputEl:o,inputEl:o?o[0]:void 0,dual:c,step:d,label:u,min:h,max:f,value:v,previousValue:v,vertical:m,verticalReversed:g,scale:b,scaleSteps:y,scaleSubSteps:w}),o&&("step min max".split(" ").forEach(function(e){!a[e]&&o.attr(e)&&(r.params[e]=parseFloat(o.attr(e)),r[e]=parseFloat(o.attr(e)))}),void 0!==o.val()&&(r.params.value=parseFloat(o.val()),r.value=parseFloat(o.val()))),r.dual&&s.addClass("range-slider-dual"),r.label&&s.addClass("range-slider-label"),r.vertical?(s.addClass("range-slider-vertical"),r.verticalReversed&&s.addClass("range-slider-vertical-reversed")):s.addClass("range-slider-horizontal");var C=$('<div class="range-bar"></div>'),x=$('<div class="range-bar-active"></div>');C.append(x);var E='\n      <div class="range-knob-wrap">\n        <div class="range-knob"></div>\n        '+(r.label?'<div class="range-knob-label"></div>':"")+"\n      </div>\n    ",k=[$(E)];r.dual&&k.push($(E)),s.append(C),k.forEach(function(e){s.append(e)});var S,T,M=[];r.label&&(M.push(k[0].find(".range-knob-label")),r.dual&&M.push(k[1].find(".range-knob-label"))),r.scale&&r.scaleSteps>1&&(S=$('\n        <div class="range-scale">\n          '+r.renderScale()+"\n        </div>\n      "),s.append(S)),Utils.extend(r,{knobs:k,labels:M,$barEl:C,$barActiveEl:x,$scaleEl:S}),s[0].f7Range=r;var P,O,D,I,B,R,L,A,z,H,U={};function N(){L=!0}function F(e){if(!T&&(r.params.draggableBar||0!==$(e.target).closest(".range-knob").length)){var t;L=!1,U.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,U.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,T=!0,P=void 0,O=s.offset(),D=O.left,I=O.top,r.vertical?(t=(U.y-I)/r.rangeHeight,r.verticalReversed||(t=1-t)):t=r.app.rtl?(D+r.rangeWidth-U.x)/r.rangeWidth:(U.x-D)/r.rangeWidth;var a=t*(r.max-r.min)+r.min;r.dual?Math.abs(r.value[0]-a)<Math.abs(r.value[1]-a)?(R=0,B=r.knobs[0],a=[a,r.value[1]]):(R=1,B=r.knobs[1],a=[r.value[0],a]):(B=r.knobs[0],a=t*(r.max-r.min)+r.min),Utils.nextTick(function(){T&&B.addClass("range-knob-active-state")},70),r.on("change",N),r.setValue(a,!0)}}function V(e){if(T){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;if(void 0===P&&(P=r.vertical?!(P||Math.abs(a-U.y)>Math.abs(t-U.x)):!!(P||Math.abs(a-U.y)>Math.abs(t-U.x))),P)T=!1;else{var n;e.preventDefault(),r.vertical?(n=(a-I)/r.rangeHeight,r.verticalReversed||(n=1-n)):n=r.app.rtl?(D+r.rangeWidth-t)/r.rangeWidth:(t-D)/r.rangeWidth;var i,s,o=n*(r.max-r.min)+r.min;if(r.dual)0===R?(i=o)>(s=r.value[1])&&(s=i):(s=o)<(i=r.value[0])&&(i=s),o=[i,s];r.setValue(o,!0)}}}function j(){if(!T)return P&&B.removeClass("range-knob-active-state"),void(T=!1);r.off("change",N),T=!1,B.removeClass("range-knob-active-state"),L&&r.$inputEl&&!r.dual&&r.$inputEl.trigger("change"),L=!1,void 0!==r.previousValue&&(r.dual&&(r.previousValue[0]!==r.value[0]||r.previousValue[1]!==r.value[1])||!r.dual&&r.previousValue!==r.value)&&(r.$el.trigger("range:changed",r,r.value),r.emit("local::changed rangeChanged",r,r.value))}function q(){r.calcSize(),r.layout()}return r.attachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};r.$el.on(t.touchEvents.start,F,e),t.on("touchmove",V),t.on("touchend:passive",j),t.on("tabShow",q),t.on("resize",q),(A=r.$el.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast")).on("modal:open",q),(z=r.$el.parents(".panel")).on("panel:open",q),(H=r.$el.parents(".page").eq(0)).on("page:reinit",q)},r.detachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};r.$el.off(t.touchEvents.start,F,e),t.off("touchmove",V),t.off("touchend:passive",j),t.off("tabShow",q),t.off("resize",q),A&&A.off("modal:open",q),z&&z.off("panel:open",q),H&&H.off("page:reinit",q),A=null,z=null,H=null},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.calcSize=function(){if(this.vertical){var e=this.$el.outerHeight();if(0===e)return;this.rangeHeight=e,this.knobHeight=this.knobs[0].outerHeight()}else{var t=this.$el.outerWidth();if(0===t)return;this.rangeWidth=t,this.knobWidth=this.knobs[0].outerWidth()}},t.prototype.layout=function(){var e,t=this,a=t.app,r=t.knobWidth,n=t.knobHeight,i=t.rangeWidth,s=t.rangeHeight,o=t.min,l=t.max,p=t.knobs,c=t.$barActiveEl,d=t.value,u=t.label,h=t.labels,f=t.vertical,v=t.verticalReversed,m=f?n:r,g=f?s:i,b=f?v?"top":"bottom":a.rtl?"right":"left";if(t.dual){var y=[(d[0]-o)/(l-o),(d[1]-o)/(l-o)];c.css(((e={})[b]=100*y[0]+"%",e[f?"height":"width"]=100*(y[1]-y[0])+"%",e)),p.forEach(function(e,r){var n=g*y[r];if("ios"===a.theme){var i=g*y[r]-m/2;i<0&&(n=m/2),i+m>g&&(n=g-m/2)}e.css(b,n+"px"),u&&h[r].text(t.formatLabel(d[r],h[r][0]))})}else{var w=(d-o)/(l-o);c.css(f?"height":"width",100*w+"%");var C=g*w;if("ios"===a.theme){var x=g*w-m/2;x<0&&(C=m/2),x+m>g&&(C=g-m/2)}p[0].css(b,C+"px"),u&&h[0].text(t.formatLabel(d,h[0][0]))}t.dual&&d.indexOf(o)>=0||!t.dual&&d===o?t.$el.addClass("range-slider-min"):t.$el.removeClass("range-slider-min"),t.dual&&d.indexOf(l)>=0||!t.dual&&d===l?t.$el.addClass("range-slider-max"):t.$el.removeClass("range-slider-max")},t.prototype.setValue=function(e,t){var a,r,n=this,i=n.step,s=n.min,o=n.max;if(n.dual){r=[n.value[0],n.value[1]];var l=e;if(Array.isArray(l)||(l=[e,e]),e[0]>e[1]&&(l=[l[0],l[0]]),(l=l.map(function(e){return Math.max(Math.min(Math.round(e/i)*i,o),s)}))[0]===n.value[0]&&l[1]===n.value[1])return n;l.forEach(function(e,t){n.value[t]=e}),a=r[0]!==l[0]||r[1]!==l[1],n.layout()}else{r=n.value;var p=Math.max(Math.min(Math.round(e/i)*i,o),s);n.value=p,n.layout(),a=r!==p}return a&&(n.previousValue=r),a?(n.$el.trigger("range:change",n,n.value),n.$inputEl&&!n.dual&&(n.$inputEl.val(n.value),t?n.$inputEl.trigger("input"):n.$inputEl.trigger("input change")),t||(n.$el.trigger("range:changed",n,n.value),n.emit("local::changed rangeChanged",n,n.value)),n.emit("local::change rangeChange",n,n.value),n):n},t.prototype.getValue=function(){return this.value},t.prototype.formatLabel=function(e,t){return this.params.formatLabel?this.params.formatLabel.call(this,e,t):e},t.prototype.formatScaleLabel=function(e){return this.params.formatScaleLabel?this.params.formatScaleLabel.call(this,e):e},t.prototype.renderScale=function(){var e=this,t=e.app,a=e.verticalReversed,r=e.vertical?a?"top":"bottom":t.rtl?"right":"left",n="";return Array.from({length:e.scaleSteps+1}).forEach(function(t,a){var i=(e.max-e.min)/e.scaleSteps,s=e.min+i*a,o=(s-e.min)/(e.max-e.min);n+='<div class="range-scale-step" style="'+r+": "+100*o+'%">'+e.formatScaleLabel(s)+"</div>",e.scaleSubSteps&&e.scaleSubSteps>1&&a<e.scaleSteps&&Array.from({length:e.scaleSubSteps-1}).forEach(function(t,a){var o=i/e.scaleSubSteps,l=(s+o*(a+1)-e.min)/(e.max-e.min);n+='<div class="range-scale-step range-scale-substep" style="'+r+": "+100*l+'%"></div>'})}),n},t.prototype.updateScale=function(){if(!this.scale||this.scaleSteps<2)return this.$scaleEl&&this.$scaleEl.remove(),void delete this.$scaleEl;this.$scaleEl||(this.$scaleEl=$('<div class="range-scale"></div>'),this.$el.append(this.$scaleEl)),this.$scaleEl.html(this.renderScale())},t.prototype.init=function(){return this.calcSize(),this.layout(),this.attachEvents(),this},t.prototype.destroy=function(){var e=this;e.$el.trigger("range:beforedestroy",e),e.emit("local::beforeDestroy rangeBeforeDestroy",e),delete e.$el[0].f7Range,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Range$1={name:"range",create:function(){var e=this;e.range=Utils.extend(ConstructorMethods({defaultSelector:".range-slider",constructor:Range,app:e,domProp:"f7Range"}),{getValue:function(t){void 0===t&&(t=".range-slider");var a=e.range.get(t);if(a)return a.getValue()},setValue:function(t,a){void 0===t&&(t=".range-slider");var r=e.range.get(t);if(r)return r.setValue(a)}})},static:{Range:Range},on:{tabMounted:function(e){var t=this;$(e).find(".range-slider-init").each(function(e,a){return new Range(t,{el:a})})},tabBeforeRemove:function(e){$(e).find(".range-slider-init").each(function(e,t){t.f7Range&&t.f7Range.destroy()})},pageInit:function(e){var t=this;e.$el.find(".range-slider-init").each(function(e,a){return new Range(t,{el:a})})},pageBeforeRemove:function(e){e.$el.find(".range-slider-init").each(function(e,t){t.f7Range&&t.f7Range.destroy()})}},vnode:{"range-slider-init":{insert:function(e){var t=e.elm;this.range.create({el:t})},destroy:function(e){var t=e.elm;t.f7Range&&t.f7Range.destroy()}}}},Stepper=function(e){function t(t,a){e.call(this,a,[t]);var r=this,n={el:null,inputEl:null,valueEl:null,value:0,formatValue:null,step:1,min:0,max:100,watchInput:!0,autorepeat:!1,autorepeatDynamic:!1,wraps:!1,manualInputMode:!1,decimalPoint:4,buttonsEndInputMode:!0};r.useModulesParams(n),r.params=Utils.extend(n,a),r.params.value<r.params.min&&(r.params.value=r.params.min),r.params.value>r.params.max&&(r.params.value=r.params.max);var i=r.params.el;if(!i)return r;var s,o,l=$(i);if(0===l.length)return r;if(l[0].f7Stepper)return l[0].f7Stepper;if(r.params.inputEl?s=$(r.params.inputEl):l.find(".stepper-input-wrap").find("input, textarea").length&&(s=l.find(".stepper-input-wrap").find("input, textarea").eq(0)),s&&s.length){"step min max".split(" ").forEach(function(e){!a[e]&&s.attr(e)&&(r.params[e]=parseFloat(s.attr(e)))});var p=parseInt(r.params.decimalPoint,10);Number.isNaN(p)?r.params.decimalPoint=0:r.params.decimalPoint=p;var c=parseFloat(s.val());void 0!==a.value||Number.isNaN(c)||!c&&0!==c||(r.params.value=c)}r.params.valueEl?o=$(r.params.valueEl):l.find(".stepper-value").length&&(o=l.find(".stepper-value").eq(0));var d=l.find(".stepper-button-plus"),u=l.find(".stepper-button-minus"),h=r.params,f=h.step,v=h.min,m=h.max,g=h.value,b=h.decimalPoint;Utils.extend(r,{app:t,$el:l,el:l[0],$buttonPlusEl:d,buttonPlusEl:d[0],$buttonMinusEl:u,buttonMinusEl:u[0],$inputEl:s,inputEl:s?s[0]:void 0,$valueEl:o,valueEl:o?o[0]:void 0,step:f,min:v,max:m,value:g,decimalPoint:b,typeModeChanged:!1}),l[0].f7Stepper=r;var y,w,C,x,E,k={},S=null,T=!1,M=!1;function P(e){y||(M||($(e.target).closest(d).length?S="increment":$(e.target).closest(u).length&&(S="decrement"),S&&(k.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,k.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,y=!0,w=void 0,function e(t,a,r,n,i,s){clearTimeout(E),E=setTimeout(function(){1===t&&(C=!0,T=!0),clearInterval(x),s(),x=setInterval(function(){s()},i),t<a&&e(t+1,a,r,n,i/2,s)},1===t?r:n)}(1,r.params.autorepeatDynamic?4:1,500,1e3,300,function(){r[S]()}))))}function O(e){if(y&&!M){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;void 0!==w||T||(w=!!(w||Math.abs(a-k.y)>Math.abs(t-k.x)));var r=Math.pow(Math.pow(t-k.x,2)+Math.pow(a-k.y,2),.5);(w||r>20)&&(y=!1,clearTimeout(E),clearInterval(x))}}function D(){clearTimeout(E),clearInterval(x),S=null,T=!1,y=!1}function I(){M?r.params.buttonsEndInputMode&&(M=!1,r.endTypeMode(!0)):C?C=!1:r.decrement(!0)}function B(){M?r.params.buttonsEndInputMode&&(M=!1,r.endTypeMode(!0)):C?C=!1:r.increment(!0)}function R(e){!e.target.readOnly&&r.params.manualInputMode&&(M=!0,"number"==typeof e.target.selectionStart&&(e.target.selectionStart=e.target.value.length,e.target.selectionEnd=e.target.value.length))}function L(e){13!==e.keyCode&&13!==e.which||(e.preventDefault(),M=!1,r.endTypeMode())}function A(){M=!1,r.endTypeMode(!0)}function z(e){M?r.typeValue(e.target.value):e.detail&&e.detail.sentByF7Stepper||r.setValue(e.target.value,!0)}return r.attachEvents=function(){u.on("click",I),d.on("click",B),r.params.watchInput&&s&&s.length&&(s.on("input",z),s.on("click",R),s.on("blur",A),s.on("keyup",L)),r.params.autorepeat&&(t.on("touchstart:passive",P),t.on("touchmove:active",O),t.on("touchend:passive",D))},r.detachEvents=function(){u.off("click",I),d.off("click",B),r.params.watchInput&&s&&s.length&&(s.off("input",z),s.off("click",R),s.off("blur",A),s.off("keyup",L))},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.minus=function(){return this.decrement()},t.prototype.plus=function(){return this.increment()},t.prototype.decrement=function(){return this.setValue(this.value-this.step,!1,!0)},t.prototype.increment=function(){return this.setValue(this.value+this.step,!1,!0)},t.prototype.setValue=function(e,t,a){var r=this.step,n=this.min,i=this.max,s=this.value,o=Math.round(e/r)*r;if(this.params.wraps&&a?(o>i&&(o=n),o<n&&(o=i)):o=Math.max(Math.min(o,i),n),Number.isNaN(o)&&(o=s),this.value=o,!(s!==o)&&!t)return this;this.$el.trigger("stepper:change",this,this.value);var l=this.formatValue(this.value);return this.$inputEl&&this.$inputEl.length&&(this.$inputEl.val(l),this.$inputEl.trigger("input change",{sentByF7Stepper:!0})),this.$valueEl&&this.$valueEl.length&&this.$valueEl.html(l),this.emit("local::change stepperChange",this,this.value),this},t.prototype.endTypeMode=function(e){var t=this.min,a=this.max,r=parseFloat(this.value);if(Number.isNaN(r)&&(r=0),r=Math.max(Math.min(r,a),t),this.value=r,!this.typeModeChanged)return this.$inputEl&&this.$inputEl.length&&!e&&this.$inputEl.blur(),this;this.typeModeChanged=!1,this.$el.trigger("stepper:change",this,this.value);var n=this.formatValue(this.value);return this.$inputEl&&this.$inputEl.length&&(this.$inputEl.val(n),this.$inputEl.trigger("input change",{sentByF7Stepper:!0}),e||this.$inputEl.blur()),this.$valueEl&&this.$valueEl.length&&this.$valueEl.html(n),this.emit("local::change stepperChange",this,this.value),this},t.prototype.typeValue=function(e){this.typeModeChanged=!0;var t=String(e);if(t.lastIndexOf(".")+1!==t.length&&t.lastIndexOf(",")+1!==t.length){var a=parseFloat(t.replace(",","."));if(0===a)return this.value=t.replace(",","."),this.$inputEl.val(this.value),this;if(Number.isNaN(a))return this.value=0,this.$inputEl.val(this.value),this;var r=Math.pow(10,this.params.decimalPoint);return a=Math.round(a*r).toFixed(this.params.decimalPoint+1)/r,this.value=parseFloat(String(a).replace(",",".")),this.$inputEl.val(this.value),this}return t.lastIndexOf(".")!==t.indexOf(".")||t.lastIndexOf(",")!==t.indexOf(",")?(t=t.slice(0,-1),this.value=t,this.$inputEl.val(this.value),this):(this.value=t,this.$inputEl.val(t),this)},t.prototype.getValue=function(){return this.value},t.prototype.formatValue=function(e){return this.params.formatValue?this.params.formatValue.call(this,e):e},t.prototype.init=function(){if(this.attachEvents(),this.$valueEl&&this.$valueEl.length){var e=this.formatValue(this.value);this.$valueEl.html(e)}return this},t.prototype.destroy=function(){var e=this;e.$el.trigger("stepper:beforedestroy",e),e.emit("local::beforeDestroy stepperBeforeDestroy",e),delete e.$el[0].f7Stepper,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Stepper$1={name:"stepper",create:function(){var e=this;e.stepper=Utils.extend(ConstructorMethods({defaultSelector:".stepper",constructor:Stepper,app:e,domProp:"f7Stepper"}),{getValue:function(t){void 0===t&&(t=".stepper");var a=e.stepper.get(t);if(a)return a.getValue()},setValue:function(t,a){void 0===t&&(t=".stepper");var r=e.stepper.get(t);if(r)return r.setValue(a)}})},static:{Stepper:Stepper},on:{tabMounted:function(e){var t=this;$(e).find(".stepper-init").each(function(e,a){var r=$(a).dataset();t.stepper.create(Utils.extend({el:a},r||{}))})},tabBeforeRemove:function(e){$(e).find(".stepper-init").each(function(e,t){t.f7Stepper&&t.f7Stepper.destroy()})},pageInit:function(e){var t=this;e.$el.find(".stepper-init").each(function(e,a){var r=$(a).dataset();t.stepper.create(Utils.extend({el:a},r||{}))})},pageBeforeRemove:function(e){e.$el.find(".stepper-init").each(function(e,t){t.f7Stepper&&t.f7Stepper.destroy()})}},vnode:{"stepper-init":{insert:function(e){var t=e.elm,a=$(t).dataset();this.stepper.create(Utils.extend({el:t},a||{}))},destroy:function(e){var t=e.elm;t.f7Stepper&&t.f7Stepper.destroy()}}}},SmartSelect=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n=Utils.extend({on:{}},t.params.smartSelect);void 0===n.searchbarDisableButton&&(n.searchbarDisableButton="aurora"!==t.theme),r.useModulesParams(n),r.params=Utils.extend({},n,a),r.app=t;var i=$(r.params.el).eq(0);if(0===i.length)return r;if(i[0].f7SmartSelect)return i[0].f7SmartSelect;var s=i.find("select").eq(0);if(0===s.length)return r;var o=$(r.params.valueEl);0===o.length&&(o=i.find(".item-after")),0===o.length&&(o=$('<div class="item-after"></div>')).insertAfter(i.find(".item-title"));var l=a.url;l||(i.attr("href")&&"#"!==i.attr("href")?l=i.attr("href"):s.attr("name")&&(l=s.attr("name").toLowerCase()+"-select/")),l||(l=r.params.url);var p=s[0].multiple,c=p?"checkbox":"radio",d=Utils.id();function u(){r.open()}function h(){var e=r.$selectEl.val();r.$el.trigger("smartselect:change",r,e),r.emit("local::change smartSelectChange",r,e),r.setTextValue()}function f(){var e,t,a,n=this.value,i=[];if("checkbox"===this.type){for(var s=0;s<r.selectEl.options.length;s+=1)(e=r.selectEl.options[s]).value===n&&(e.selected=this.checked),e.selected&&(t=(a=e.dataset?e.dataset.displayAs:$(e).data("display-value-as"))&&void 0!==a?a:e.textContent,i.push(t.trim()));r.maxLength&&r.checkMaxLength()}else i=[t=(a=(e=r.$selectEl.find('option[value="'+n+'"]')[0]).dataset?e.dataset.displayAs:$(e).data("display-as"))&&void 0!==a?a:e.textContent],r.selectEl.value=n;r.$selectEl.trigger("change"),r.$valueEl.text(i.join(", ")),r.params.closeOnSelect&&"radio"===r.inputType&&r.close()}return Utils.extend(r,{$el:i,el:i[0],$selectEl:s,selectEl:s[0],$valueEl:o,valueEl:o[0],url:l,multiple:p,inputType:c,id:d,view:void 0,inputName:c+"-"+d,selectName:s.attr("name"),maxLength:s.attr("maxlength")||a.maxLength}),i[0].f7SmartSelect=r,r.attachEvents=function(){i.on("click",u),i.on("change","select",h)},r.detachEvents=function(){i.off("click",u),i.off("change","select",h)},r.attachInputsEvents=function(){r.$containerEl.on("change",'input[type="checkbox"], input[type="radio"]',f)},r.detachInputsEvents=function(){r.$containerEl.off("change",'input[type="checkbox"], input[type="radio"]',f)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setValue=function(e){var t,a,r,n=this,i=e,s=[];if(n.multiple){Array.isArray(i)||(i=[i]);for(var o=0;o<n.selectEl.options.length;o+=1)t=n.selectEl.options[o],i.indexOf(t.value)>=0?t.selected=!0:t.selected=!1,t.selected&&(r=(a=t.dataset?t.dataset.displayAs:$(t).data("display-value-as"))&&void 0!==a?a:t.textContent,s.push(r.trim()))}else s=[r=(a=(t=n.$selectEl.find('option[value="'+i+'"]')[0]).dataset?t.dataset.displayAs:$(t).data("display-as"))&&void 0!==a?a:t.textContent],n.selectEl.value=i;n.$valueEl.text(s.join(", "))},t.prototype.getValue=function(){return this.$selectEl.val()},t.prototype.getView=function(){var e=this,t=e.view||e.params.view;if(t||(t=e.$el.parents(".view").length&&e.$el.parents(".view")[0].f7View),!t)throw Error("Smart Select requires initialized View");return e.view=t,t},t.prototype.checkMaxLength=function(){var e=this.$containerEl;this.selectEl.selectedOptions.length>=this.maxLength?e.find('input[type="checkbox"]').each(function(e,t){t.checked?$(t).parents("li").removeClass("disabled"):$(t).parents("li").addClass("disabled")}):e.find(".disabled").removeClass("disabled")},t.prototype.setTextValue=function(e){var t=[];void 0!==e?t=Array.isArray(e)?e:[e]:this.$selectEl.find("option").each(function(e,a){var r=$(a);if(a.selected){var n=a.dataset?a.dataset.displayAs:r.data("display-value-as");n&&void 0!==n?t.push(n):t.push(a.textContent.trim())}}),this.$valueEl.text(t.join(", "))},t.prototype.getItemsData=function(){var e,t=this,a=[];return t.$selectEl.find("option").each(function(r,n){var i=$(n),s=i.dataset(),o=s.optionImage||t.params.optionImage,l=s.optionIcon||t.params.optionIcon,p=o||l,c=s.optionColor,d=s.optionClass||"";i[0].disabled&&(d+=" disabled");var u=i.parent("optgroup")[0],h=u&&u.label,f=!1;u&&u!==e&&(f=!0,e=u,a.push({groupLabel:h,isLabel:f})),a.push({value:i[0].value,text:i[0].textContent.trim(),selected:i[0].selected,groupEl:u,groupLabel:h,image:o,icon:l,color:c,className:d,disabled:i[0].disabled,id:t.id,hasMedia:p,checkbox:"checkbox"===t.inputType,radio:"radio"===t.inputType,inputName:t.inputName,inputType:t.inputType})}),t.items=a,a},t.prototype.renderSearchbar=function(){var e=this;return e.params.renderSearchbar?e.params.renderSearchbar.call(e):'\n      <form class="searchbar">\n        <div class="searchbar-inner">\n          <div class="searchbar-input-wrap">\n            <input type="search" placeholder="'+e.params.searchbarPlaceholder+'"/>\n            <i class="searchbar-icon"></i>\n            <span class="input-clear-button"></span>\n          </div>\n          '+(e.params.searchbarDisableButton?'\n          <span class="searchbar-disable-button">'+e.params.searchbarDisableText+"</span>\n          ":"")+"\n        </div>\n      </form>\n    "},t.prototype.renderItem=function(e,t){return this.params.renderItem?this.params.renderItem.call(this,e,t):e.isLabel?'<li class="item-divider">'+e.groupLabel+"</li>":'\n        <li class="'+(e.className||"")+'">\n          <label class="item-'+e.inputType+' item-content">\n            <input type="'+e.inputType+'" name="'+e.inputName+'" value="'+e.value+'" '+(e.selected?"checked":"")+'/>\n            <i class="icon icon-'+e.inputType+'"></i>\n            '+(e.hasMedia?'\n              <div class="item-media">\n                '+(e.icon?'<i class="icon '+e.icon+'"></i>':"")+"\n                "+(e.image?'<img src="'+e.image+'">':"")+"\n              </div>\n            ":"")+'\n            <div class="item-inner">\n              <div class="item-title'+(e.color?" color-"+e.color:"")+'">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      "},t.prototype.renderItems=function(){var e=this;return e.params.renderItems?e.params.renderItems.call(e,e.items):"\n      "+e.items.map(function(t,a){return""+e.renderItem(t,a)}).join("")+"\n    "},t.prototype.renderPage=function(){var e=this;if(e.params.renderPage)return e.params.renderPage.call(e,e.items);var t=e.params.pageTitle;if(void 0===t){var a=e.$el.find(".item-title");t=a.length?a.text().trim():""}return'\n      <div class="page smart-select-page '+e.params.cssClass+'" data-name="smart-select-page" data-select-name="'+e.selectName+'">\n        <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n          <div class="navbar-inner sliding '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n            <div class="left">\n              <a href="#" class="link back">\n                <i class="icon icon-back"></i>\n                <span class="ios-only">'+e.params.pageBackLinkText+"</span>\n              </a>\n            </div>\n            "+(t?'<div class="title">'+t+"</div>":"")+"\n            "+(e.params.searchbar?'<div class="subnavbar">'+e.renderSearchbar()+"</div>":"")+"\n          </div>\n        </div>\n        "+(e.params.searchbar?'<div class="searchbar-backdrop"></div>':"")+'\n        <div class="page-content">\n          <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n            <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderPopup=function(){var e=this;if(e.params.renderPopup)return e.params.renderPopup.call(e,e.items);var t=e.params.pageTitle;if(void 0===t){var a=e.$el.find(".item-title");t=a.length?a.text().trim():""}return'\n      <div class="popup smart-select-popup '+(e.params.cssClass||"")+" "+(e.params.popupTabletFullscreen?"popup-tablet-fullscreen":"")+'" data-select-name="'+e.selectName+'">\n        <div class="view">\n          <div class="page smart-select-page '+(e.params.searchbar?"page-with-subnavbar":"")+'" data-name="smart-select-page">\n            <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n              <div class="navbar-inner sliding">\n                <div class="left">\n                  <a href="#" class="link popup-close" data-popup=".smart-select-popup[data-select-name=\''+e.selectName+'\']">\n                    <i class="icon icon-back"></i>\n                    <span class="ios-only">'+e.params.popupCloseLinkText+"</span>\n                  </a>\n                </div>\n                "+(t?'<div class="title">'+t+"</div>":"")+"\n                "+(e.params.searchbar?'<div class="subnavbar">'+e.renderSearchbar()+"</div>":"")+"\n              </div>\n            </div>\n            "+(e.params.searchbar?'<div class="searchbar-backdrop"></div>':"")+'\n            <div class="page-content">\n              <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n                <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderSheet=function(){var e=this;return e.params.renderSheet?e.params.renderSheet.call(e,e.items):'\n      <div class="sheet-modal smart-select-sheet '+e.params.cssClass+'" data-select-name="'+e.selectName+'">\n        <div class="toolbar toolbar-top '+(e.params.toolbarColorTheme?"color-"+e.params.toolbarColorTheme:"")+'">\n          <div class="toolbar-inner">\n            <div class="left"></div>\n            <div class="right">\n              <a class="link sheet-close">'+e.params.sheetCloseLinkText+'</a>\n            </div>\n          </div>\n        </div>\n        <div class="sheet-modal-inner">\n          <div class="page-content">\n            <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n              <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n            </div>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderPopover=function(){var e=this;return e.params.renderPopover?e.params.renderPopover.call(e,e.items):'\n      <div class="popover smart-select-popover '+e.params.cssClass+'" data-select-name="'+e.selectName+'">\n        <div class="popover-inner">\n          <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n            <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.onOpen=function(e,t){var a=this,r=a.app,n=$(t);if(a.$containerEl=n,a.openedIn=e,a.opened=!0,a.params.virtualList&&(a.vl=r.virtualList.create({el:n.find(".virtual-list"),items:a.items,renderItem:a.renderItem.bind(a),height:a.params.virtualListHeight,searchByItem:function(e,t){return!!(t.text&&t.text.toLowerCase().indexOf(e.trim().toLowerCase())>=0)}})),a.params.searchbar){var i=n.find(".searchbar");if("page"===e&&"ios"===r.theme&&(i=$(r.navbar.getElByPage(n)).find(".searchbar")),a.params.appendSearchbarNotFound&&("page"===e||"popup"===e)){var s=null;(s="string"==typeof a.params.appendSearchbarNotFound?$('<div class="block searchbar-not-found">'+a.params.appendSearchbarNotFound+"</div>"):"boolean"==typeof a.params.appendSearchbarNotFound?$('<div class="block searchbar-not-found">Nothing found</div>'):a.params.appendSearchbarNotFound)&&n.find(".page-content").append(s[0])}var o=Utils.extend({el:i,backdropEl:n.find(".searchbar-backdrop"),searchContainer:".smart-select-list-"+a.id,searchIn:".item-title"},"object"==typeof a.params.searchbar?a.params.searchbar:{});a.searchbar=r.searchbar.create(o)}a.maxLength&&a.checkMaxLength(),a.params.closeOnSelect&&a.$containerEl.find('input[type="radio"][name="'+a.inputName+'"]:checked').parents("label").once("click",function(){a.close()}),a.attachInputsEvents(),a.$el.trigger("smartselect:open",a),a.emit("local::open smartSelectOpen",a)},t.prototype.onOpened=function(){this.$el.trigger("smartselect:opened",this),this.emit("local::opened smartSelectOpened",this)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.vl&&e.vl.destroy&&(e.vl.destroy(),e.vl=null,delete e.vl),e.searchbar&&e.searchbar.destroy&&(e.searchbar.destroy(),e.searchbar=null,delete e.searchbar),e.detachInputsEvents(),e.$el.trigger("smartselect:close",e),e.emit("local::close smartSelectClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$containerEl=null,delete e.$containerEl,e.$el.trigger("smartselect:closed",e),e.emit("local::closed smartSelectClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;e.getItemsData();var t=e.renderPage(e.items);return e.getView().router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}}}}),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderPopup(e.items),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open();return e},t.prototype.openSheet=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderSheet(e.items),backdrop:!1,scrollToEl:e.$el,closeByOutsideClick:!0,on:{sheetOpen:function(t){e.onOpen("sheet",t.el)},sheetOpened:function(t){e.onOpened("sheet",t.el)},sheetClose:function(t){e.onClose("sheet",t.el)},sheetClosed:function(t){e.onClosed("sheet",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,sheet:t}}):e.modal=e.app.sheet.create(t).open();return e},t.prototype.openPopover=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderPopover(e.items),targetEl:e.$el,on:{popoverOpen:function(t){e.onOpen("popover",t.el)},popoverOpened:function(t){e.onOpened("popover",t.el)},popoverClose:function(t){e.onClose("popover",t.el)},popoverClosed:function(t){e.onClosed("popover",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,popover:t}}):e.modal=e.app.popover.create(t).open();return e},t.prototype.open=function(e){var t=this;return t.opened?t:(t["open"+(e||t.params.openIn).split("").map(function(e,t){return 0===t?e.toUpperCase():e}).join("")](),t)},t.prototype.close=function(){var e=this;if(!e.opened)return e;e.params.routableModals||"page"===e.openedIn?e.getView().router.back():(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.modal.destroy(),delete e.modal})}),e.modal.close());return e},t.prototype.init=function(){this.attachEvents(),this.setTextValue()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy smartSelectBeforeDestroy",e),e.$el.trigger("smartselect:beforedestroy",e),e.detachEvents(),delete e.$el[0].f7SmartSelect,Utils.deleteProps(e),e.destroyed=!0},t}(Framework7Class),SmartSelect$1={name:"smartSelect",params:{smartSelect:{el:void 0,valueEl:void 0,openIn:"page",pageTitle:void 0,pageBackLinkText:"Back",popupCloseLinkText:"Close",popupTabletFullscreen:!1,sheetCloseLinkText:"Done",searchbar:!1,searchbarPlaceholder:"Search",searchbarDisableText:"Cancel",searchbarDisableButton:void 0,closeOnSelect:!1,virtualList:!1,virtualListHeight:void 0,formColorTheme:void 0,navbarColorTheme:void 0,routableModals:!0,url:"select/",cssClass:"",renderPage:void 0,renderPopup:void 0,renderSheet:void 0,renderPopover:void 0,renderItems:void 0,renderItem:void 0,renderSearchbar:void 0}},static:{SmartSelect:SmartSelect},create:function(){var e=this;e.smartSelect=Utils.extend(ConstructorMethods({defaultSelector:".smart-select",constructor:SmartSelect,app:e,domProp:"f7SmartSelect"}),{open:function(t){var a=e.smartSelect.get(t);if(a&&a.open)return a.open()},close:function(t){var a=e.smartSelect.get(t);if(a&&a.close)return a.close()}})},on:{tabMounted:function(e){var t=this;$(e).find(".smart-select-init").each(function(e,a){t.smartSelect.create(Utils.extend({el:a},$(a).dataset()))})},tabBeforeRemove:function(e){$(e).find(".smart-select-init").each(function(e,t){t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()})},pageInit:function(e){var t=this;e.$el.find(".smart-select-init").each(function(e,a){t.smartSelect.create(Utils.extend({el:a},$(a).dataset()))})},pageBeforeRemove:function(e){e.$el.find(".smart-select-init").each(function(e,t){t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()})}},clicks:{".smart-select":function(e,t){e[0].f7SmartSelect||this.smartSelect.create(Utils.extend({el:e},t)).open()}},vnode:{"smart-select-init":{insert:function(e){var t=e.elm;this.smartSelect.create(Utils.extend({el:t},$(t).dataset()))},destroy:function(e){var t=e.elm;t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()}}}},Grid={name:"grid"};function toJalaali(e,t,a){return"[object Date]"===Object.prototype.toString.call(e)&&(a=e.getDate(),t=e.getMonth()+1,e=e.getFullYear()),d2j(g2d(e,t,a))}function toGregorian(e,t,a){return d2g(j2d(e,t,a))}function isLeapJalaaliYear(e){return 0===jalCal(e).leap}function monthLength(e,t){return t<=6?31:t<=11?30:isLeapJalaaliYear(e)?30:29}function jalCal(e){var t,a,r,n,i,s,o=[-61,9,38,199,426,686,756,818,1111,1181,1210,1635,2060,2097,2192,2262,2324,2394,2456,3178],l=o.length,p=e+621,c=-14,d=o[0];if(e<d||e>=o[l-1])throw new Error("Invalid Jalaali year "+e);for(s=1;s<l&&(a=(t=o[s])-d,!(e<t));s+=1)c=c+8*div(a,33)+div(mod(a,33),4),d=t;return c=c+8*div(i=e-d,33)+div(mod(i,33)+3,4),4===mod(a,33)&&a-i==4&&(c+=1),n=20+c-(div(p,4)-div(3*(div(p,100)+1),4)-150),a-i<6&&(i=i-a+33*div(a+4,33)),-1===(r=mod(mod(i+1,33)-1,4))&&(r=4),{leap:r,gy:p,march:n}}function j2d(e,t,a){var r=jalCal(e);return g2d(r.gy,3,r.march)+31*(t-1)-div(t,7)*(t-7)+a-1}function d2j(e){var t,a=d2g(e).gy,r=a-621,n=jalCal(r);if((t=e-g2d(a,3,n.march))>=0){if(t<=185)return{jy:r,jm:1+div(t,31),jd:mod(t,31)+1};t-=186}else r-=1,t+=179,1===n.leap&&(t+=1);return{jy:r,jm:7+div(t,30),jd:mod(t,30)+1}}function g2d(e,t,a){var r=div(1461*(e+div(t-8,6)+100100),4)+div(153*mod(t+9,12)+2,5)+a-34840408;return r=r-div(3*div(e+100100+div(t-8,6),100),4)+752}function d2g(e){var t,a,r,n;return t=(t=4*e+139361631)+4*div(3*div(4*e+183187720,146097),4)-3908,a=5*div(mod(t,1461),4)+308,r=div(mod(a,153),5)+1,n=mod(div(a,153),12)+1,{gy:div(t,1461)-100100+div(8-n,6),gm:n,gd:r}}function div(e,t){return~~(e/t)}function mod(e,t){return e-~~(e/t)*t}function fixDate(e,t,a){for(t>11&&(e+=Math.floor(t/12),t%=12);t<0;)e-=1,t+=12;for(;a>monthLength(e,t+1);)a-=monthLength(e=0===(t=11!==t?t+1:0)?e+1:e,t+1);for(;a<=0;)a+=monthLength(e=11===(t=0!==t?t-1:11)?e-1:e,t+1);return[e,t||0,a||1]}var methods=["getHours","getMilliseconds","getMinutes","getSeconds","getTime","getTimezoneOffset","getUTCDate","getUTCDay","getUTCFullYear","getUTCHours","getUTCMilliseconds","getUTCMinutes","getUTCMonth","getUTCSeconds","now","parse","setHours","setMilliseconds","setMinutes","setSeconds","setTime","setUTCDate","setUTCFullYear","setUTCHours","setUTCMilliseconds","setUTCMinutes","setUTCMonth","setUTCSeconds","toDateString","toISOString","toJSON","toLocaleDateString","toLocaleTimeString","toLocaleString","toTimeString","toUTCString","UTC","valueOf"],DAY_NAMES=["Shanbe","Yekshanbe","Doshanbe","Seshanbe","Chaharshanbe","Panjshanbe","Jom'e"],PERSIAN_DAY_NAMES=["شنبه","یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه","جمعه"],MONTH_NAMES=["Farvardin","Ordibehesht","Khordad","Tir","Mordad","Shahrivar","Mehr","Aban","Azar","Dey","Bahman","Esfand"],PERSIAN_MONTH_NAMES=["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"],PERSIAN_NUMBERS=["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"],IDate=function(e){function t(){for(var a,r=[],n=arguments.length;n--;)r[n]=arguments[n];if(e.call(this),0===r.length)a=e.now();else if(1===r.length)a=r[0]instanceof e?r[0].getTime():r[0];else{var i=fixDate(r[0],r[1]||0,void 0===r[2]?1:r[2]),s=toGregorian(i[0],i[1]+1,i[2]);a=[s.gy,s.gm-1,s.gd].concat([r[3]||0,r[4]||0,r[5]||0,r[6]||0])}Array.isArray(a)?this.gdate=new(Function.prototype.bind.apply(e,[null].concat(a))):this.gdate=new e(a);var o=toJalaali(this.gdate.getFullYear(),this.gdate.getMonth()+1,this.gdate.getDate());this.jdate=[o.jy,o.jm-1,o.jd],methods.forEach(function(e){t.prototype[e]=function(){var t;return(t=this.gdate)[e].apply(t,arguments)}})}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.getFullYear=function(){return this.jdate[0]},t.prototype.setFullYear=function(e){return this.jdate=fixDate(e,this.jdate[1],this.jdate[2]),this.syncDate(),this.gdate.getTime()},t.prototype.getMonth=function(){return this.jdate[1]},t.prototype.setMonth=function(e){return this.jdate=fixDate(this.jdate[0],e,this.jdate[2]),this.syncDate(),this.gdate.getTime()},t.prototype.getDate=function(){return this.jdate[2]},t.prototype.setDate=function(e){return this.jdate=fixDate(this.jdate[0],this.jdate[1],e),this.syncDate(),this.gdate.getTime()},t.prototype.getDay=function(){return(this.gdate.getDay()+1)%7},t.prototype.syncDate=function(){var e=toGregorian(this.jdate[0],this.jdate[1]+1,this.jdate[2]);this.gdate.setFullYear(e.gy),this.gdate.setMonth(e.gm-1),this.gdate.setDate(e.gd)},t.prototype.toString=function(e){void 0===e&&(e=!0);var t=function(e){return 1===e.toString().length?"0"+e:e.toString()},a=t(this.getHours())+":"+t(this.getMinutes())+":"+t(this.getSeconds());return e?(PERSIAN_DAY_NAMES[this.getDay()]+" "+this.getDate()+" "+PERSIAN_MONTH_NAMES[this.getMonth()]+" "+this.getFullYear()+" ساعت "+a).replace(/./g,function(e){return PERSIAN_NUMBERS[e]||e}):DAY_NAMES[this.getDay()]+" "+this.getDate()+" "+MONTH_NAMES[this.getMonth()]+" "+this.getFullYear()+" "+a},t}(Date),Calendar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,n,i,s=this;if(s.params=Utils.extend({},t.params.calendar,a),"jalali"===s.params.calendarType&&Object.keys(s.params.jalali).forEach(function(e){a[e]||(s.params[e]=s.params.jalali[e])}),"jalali"===s.params.calendarType?s.DateHandleClass=IDate:s.DateHandleClass=Date,s.params.containerEl&&0===(r=$(s.params.containerEl)).length)return s;s.params.inputEl&&(n=$(s.params.inputEl)),n&&(i=n.parents(".view").length&&n.parents(".view")[0].f7View),i||(i=t.views.main);var o="horizontal"===s.params.direction,l=1;function p(){s.open()}function c(e){e.preventDefault()}function d(e){var t=$(e.target);s.isPopover()||s.opened&&!s.closing&&(t.closest('[class*="backdrop"]').length||(n&&n.length>0?t[0]!==n[0]&&0===t.closest(".sheet-modal, .calendar-modal").length&&s.close():0===$(e.target).closest(".sheet-modal, .calendar-modal").length&&s.close()))}return o&&(l=t.rtl?-1:1),Utils.extend(s,{app:t,$containerEl:r,containerEl:r&&r[0],inline:r&&r.length>0,$inputEl:n,inputEl:n&&n[0],initialized:!1,opened:!1,url:s.params.url,isHorizontal:o,inverter:l,view:i,animating:!1}),Utils.extend(s,{attachInputEvents:function(){s.$inputEl.on("click",p),s.params.inputReadOnly&&s.$inputEl.on("focus mousedown",c)},detachInputEvents:function(){s.$inputEl.off("click",p),s.params.inputReadOnly&&s.$inputEl.off("focus mousedown",c)},attachHtmlEvents:function(){t.on("click",d)},detachHtmlEvents:function(){t.off("click",d)}}),s.attachCalendarEvents=function(){var e,a,r,n,i,o,l,p,c,d,u,h,f,v=!0,m=s.$el,g=s.$wrapperEl;function b(t){a||e||(e=!0,r="touchstart"===t.type?t.targetTouches[0].pageX:t.pageX,i=r,n="touchstart"===t.type?t.targetTouches[0].pageY:t.pageY,o=n,l=(new s.DateHandleClass).getTime(),u=0,v=!0,f=void 0,p=s.monthsTranslate)}function y(t){if(e){var l=s.isHorizontal;i="touchmove"===t.type?t.targetTouches[0].pageX:t.pageX,o="touchmove"===t.type?t.targetTouches[0].pageY:t.pageY,void 0===f&&(f=!!(f||Math.abs(o-n)>Math.abs(i-r))),l&&f?e=!1:(t.preventDefault(),s.animating?e=!1:(v=!1,a||(a=!0,c=g[0].offsetWidth,d=g[0].offsetHeight,g.transition(0)),u=(h=l?i-r:o-n)/(l?c:d),p=100*(s.monthsTranslate*s.inverter+u),g.transform("translate3d("+(l?p:0)+"%, "+(l?0:p)+"%, 0)")))}}function w(){if(!e||!a)return e=!1,void(a=!1);e=!1,a=!1,(new s.DateHandleClass).getTime()-l<300?Math.abs(h)<10?s.resetMonth():h>=10?t.rtl?s.nextMonth():s.prevMonth():t.rtl?s.prevMonth():s.nextMonth():u<=-.5?t.rtl?s.prevMonth():s.nextMonth():u>=.5?t.rtl?s.nextMonth():s.prevMonth():s.resetMonth(),setTimeout(function(){v=!0},100)}function C(e){if(v){var t=$(e.target).parents(".calendar-day");if(0===t.length&&$(e.target).hasClass("calendar-day")&&(t=$(e.target)),0!==t.length&&!t.hasClass("calendar-day-disabled")){s.params.rangePicker||(t.hasClass("calendar-day-next")&&s.nextMonth(),t.hasClass("calendar-day-prev")&&s.prevMonth());var a=parseInt(t.attr("data-year"),10),r=parseInt(t.attr("data-month"),10),n=parseInt(t.attr("data-day"),10);s.emit("local::dayClick calendarDayClick",s,t[0],a,r,n),(!t.hasClass("calendar-day-selected")||s.params.multiple||s.params.rangePicker)&&s.addValue(new s.DateHandleClass(a,r,n,0,0,0)),s.params.closeOnSelect&&(s.params.rangePicker&&2===s.value.length||!s.params.rangePicker)&&s.close()}}}function x(){s.nextMonth()}function E(){s.prevMonth()}function k(){s.nextYear()}function S(){s.prevYear()}var T=!("touchstart"!==t.touchEvents.start||!t.support.passiveListener)&&{passive:!0,capture:!1};m.find(".calendar-prev-month-button").on("click",E),m.find(".calendar-next-month-button").on("click",x),m.find(".calendar-prev-year-button").on("click",S),m.find(".calendar-next-year-button").on("click",k),g.on("click",C),s.params.touchMove&&(g.on(t.touchEvents.start,b,T),t.on("touchmove:active",y),t.on("touchend:passive",w)),s.detachCalendarEvents=function(){m.find(".calendar-prev-month-button").off("click",E),m.find(".calendar-next-month-button").off("click",x),m.find(".calendar-prev-year-button").off("click",S),m.find(".calendar-next-year-button").off("click",k),g.off("click",C),s.params.touchMove&&(g.off(t.touchEvents.start,b,T),t.off("touchmove:active",y),t.off("touchend:passive",w))}},s.init(),s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.normalizeDate=function(e){var t=new this.DateHandleClass(e);return new this.DateHandleClass(t.getFullYear(),t.getMonth(),t.getDate())},t.prototype.normalizeValues=function(e){var t=this,a=[];return e&&Array.isArray(e)&&(a=e.map(function(e){return t.normalizeDate(e)})),a},t.prototype.initInput=function(){this.$inputEl&&this.params.inputReadOnly&&this.$inputEl.prop("readOnly",!0)},t.prototype.isPopover=function(){var e=this.app,t=this.modal,a=this.params;if("sheet"===a.openIn)return!1;if(t&&"popover"!==t.type)return!1;if(!this.inline&&this.inputEl){if("popover"===a.openIn)return!0;if(e.device.ios)return!!e.device.ipad;if(e.width>=768)return!0;if(e.device.desktop&&"aurora"===e.theme)return!0}return!1},t.prototype.formatDate=function(e){var t=new this.DateHandleClass(e),a=t.getFullYear(),r=t.getMonth(),n=r+1,i=t.getDate(),s=t.getDay(),o=this.params,l=o.dateFormat,p=o.monthNames,c=o.monthNamesShort,d=o.dayNames,u=o.dayNamesShort;return l.replace(/yyyy/g,a).replace(/yy/g,String(a).substring(2)).replace(/mm/g,n<10?"0"+n:n).replace(/m(\W+)/g,n+"$1").replace(/MM/g,p[r]).replace(/M(\W+)/g,c[r]+"$1").replace(/dd/g,i<10?"0"+i:i).replace(/d(\W+)/g,i+"$1").replace(/DD/g,d[s]).replace(/D(\W+)/g,u[s]+"$1")},t.prototype.formatValue=function(){var e=this,t=e.value;return e.params.formatValue?e.params.formatValue.call(e,t):t.map(function(t){return e.formatDate(t)}).join(e.params.rangePicker?" - ":", ")},t.prototype.addValue=function(e){var t=this.params,a=t.multiple,r=t.rangePicker,n=t.rangePickerMinDays,i=t.rangePickerMaxDays;if(a){var s;this.value||(this.value=[]);for(var o=0;o<this.value.length;o+=1)new this.DateHandleClass(e).getTime()===new this.DateHandleClass(this.value[o]).getTime()&&(s=o);void 0===s?this.value.push(e):this.value.splice(s,1),this.updateValue()}else r?(this.value||(this.value=[]),2!==this.value.length&&0!==this.value.length||(this.value=[]),0===this.value.length||Math.abs(this.value[0].getTime()-e.getTime())>=60*(n-1)*60*24*1e3&&(0===i||Math.abs(this.value[0].getTime()-e.getTime())<=60*(i-1)*60*24*1e3)?this.value.push(e):this.value=[],this.value.sort(function(e,t){return e-t}),this.updateValue()):(this.value=[e],this.updateValue())},t.prototype.setValue=function(e){this.value=e,this.updateValue()},t.prototype.getValue=function(){return this.value},t.prototype.updateValue=function(e){var t,a,r=this.$el,n=this.$wrapperEl,i=this.$inputEl,s=this.value,o=this.params;if(r&&r.length>0)if(n.find(".calendar-day-selected").removeClass("calendar-day-selected"),o.rangePicker&&2===s.length)for(t=new this.DateHandleClass(s[0]).getTime();t<=new this.DateHandleClass(s[1]).getTime();t+=864e5)a=new this.DateHandleClass(t),n.find('.calendar-day[data-date="'+a.getFullYear()+"-"+a.getMonth()+"-"+a.getDate()+'"]').addClass("calendar-day-selected");else for(t=0;t<this.value.length;t+=1)a=new this.DateHandleClass(s[t]),n.find('.calendar-day[data-date="'+a.getFullYear()+"-"+a.getMonth()+"-"+a.getDate()+'"]').addClass("calendar-day-selected");if(e||this.emit("local::change calendarChange",this,s),i&&i.length||o.header){var l=this.formatValue(s);o.header&&r&&r.length&&r.find(".calendar-selected-date").text(l),i&&i.length&&!e&&(i.val(l),i.trigger("change"))}},t.prototype.updateCurrentMonthYear=function(e){var t=this.$months,a=this.$el,r=this.params;void 0===e?(this.currentMonth=parseInt(t.eq(1).attr("data-month"),10),this.currentYear=parseInt(t.eq(1).attr("data-year"),10)):(this.currentMonth=parseInt(t.eq("next"===e?t.length-1:0).attr("data-month"),10),this.currentYear=parseInt(t.eq("next"===e?t.length-1:0).attr("data-year"),10)),a.find(".current-month-value").text(r.monthNames[this.currentMonth]),a.find(".current-year-value").text(this.currentYear)},t.prototype.update=function(){var e=this,t=e.currentYear,a=e.currentMonth,r=e.$wrapperEl,n=new e.DateHandleClass(t,a),i=e.renderMonth(n,"prev"),s=e.renderMonth(n),o=e.renderMonth(n,"next");r.transition(0).html(""+i+s+o).transform("translate3d(0,0,0)"),e.$months=r.find(".calendar-month"),e.monthsTranslate=0,e.setMonthsTranslate(),e.$months.each(function(t,a){e.emit("local::monthAdd calendarMonthAdd",a)})},t.prototype.onMonthChangeStart=function(e){var t=this.$months,a=this.currentYear,r=this.currentMonth;this.updateCurrentMonthYear(e),t.removeClass("calendar-month-current calendar-month-prev calendar-month-next");var n="next"===e?t.length-1:0;t.eq(n).addClass("calendar-month-current"),t.eq("next"===e?n-1:n+1).addClass("next"===e?"calendar-month-prev":"calendar-month-next"),this.emit("local::monthYearChangeStart calendarMonthYearChangeStart",this,a,r)},t.prototype.onMonthChangeEnd=function(e,t){var a,r,n,i=this.currentYear,s=this.currentMonth,o=this.$wrapperEl,l=this.monthsTranslate;this.animating=!1,o.find(".calendar-month:not(.calendar-month-prev):not(.calendar-month-current):not(.calendar-month-next)").remove(),void 0===e&&(e="next",t=!0),t?(o.find(".calendar-month-next, .calendar-month-prev").remove(),r=this.renderMonth(new this.DateHandleClass(i,s),"prev"),a=this.renderMonth(new this.DateHandleClass(i,s),"next")):n=this.renderMonth(new this.DateHandleClass(i,s),e),("next"===e||t)&&o.append(n||a),("prev"===e||t)&&o.prepend(n||r);var p=o.find(".calendar-month");this.$months=p,this.setMonthsTranslate(l),this.emit("local::monthAdd calendarMonthAdd",this,"next"===e?p.eq(p.length-1)[0]:p.eq(0)[0]),this.emit("local::monthYearChangeEnd calendarMonthYearChangeEnd",this,i,s)},t.prototype.setMonthsTranslate=function(e){var t=this.$months,a=this.isHorizontal,r=this.inverter;e=e||this.monthsTranslate||0,void 0===this.monthsTranslate&&(this.monthsTranslate=e),t.removeClass("calendar-month-current calendar-month-prev calendar-month-next");var n=100*-(e+1)*r,i=100*-e*r,s=100*-(e-1)*r;t.eq(0).transform("translate3d("+(a?n:0)+"%, "+(a?0:n)+"%, 0)").addClass("calendar-month-prev"),t.eq(1).transform("translate3d("+(a?i:0)+"%, "+(a?0:i)+"%, 0)").addClass("calendar-month-current"),t.eq(2).transform("translate3d("+(a?s:0)+"%, "+(a?0:s)+"%, 0)").addClass("calendar-month-next")},t.prototype.nextMonth=function(e){var t=this,a=t.params,r=t.$wrapperEl,n=t.inverter,i=t.isHorizontal;void 0!==e&&"object"!=typeof e||(e="",a.animate||(e=0));var s=parseInt(t.$months.eq(t.$months.length-1).attr("data-month"),10),o=parseInt(t.$months.eq(t.$months.length-1).attr("data-year"),10),l=new t.DateHandleClass(o,s).getTime(),p=!t.animating;if(a.maxDate&&l>new t.DateHandleClass(a.maxDate).getTime())t.resetMonth();else{if(t.monthsTranslate-=1,s===t.currentMonth){var c=100*-t.monthsTranslate*n,d=$(t.renderMonth(l,"next")).transform("translate3d("+(i?c:0)+"%, "+(i?0:c)+"%, 0)").addClass("calendar-month-next");r.append(d[0]),t.$months=r.find(".calendar-month"),t.emit("local::monthAdd calendarMonthAdd",t.$months.eq(t.$months.length-1)[0])}t.animating=!0,t.onMonthChangeStart("next");var u=100*t.monthsTranslate*n;r.transition(e).transform("translate3d("+(i?u:0)+"%, "+(i?0:u)+"%, 0)"),p&&r.transitionEnd(function(){t.onMonthChangeEnd("next")}),a.animate||t.onMonthChangeEnd("next")}},t.prototype.prevMonth=function(e){var t=this,a=t.params,r=t.$wrapperEl,n=t.inverter,i=t.isHorizontal;void 0!==e&&"object"!=typeof e||(e="",a.animate||(e=0));var s=parseInt(t.$months.eq(0).attr("data-month"),10),o=parseInt(t.$months.eq(0).attr("data-year"),10),l=new t.DateHandleClass(o,s+1,-1).getTime(),p=!t.animating;if(a.minDate){var c=new t.DateHandleClass(a.minDate);if(l<(c=new t.DateHandleClass(c.getFullYear(),c.getMonth(),1)).getTime())return void t.resetMonth()}if(t.monthsTranslate+=1,s===t.currentMonth){var d=100*-t.monthsTranslate*n,u=$(t.renderMonth(l,"prev")).transform("translate3d("+(i?d:0)+"%, "+(i?0:d)+"%, 0)").addClass("calendar-month-prev");r.prepend(u[0]),t.$months=r.find(".calendar-month"),t.emit("local::monthAdd calendarMonthAdd",t.$months.eq(0)[0])}t.animating=!0,t.onMonthChangeStart("prev");var h=100*t.monthsTranslate*n;r.transition(e).transform("translate3d("+(i?h:0)+"%, "+(i?0:h)+"%, 0)"),p&&r.transitionEnd(function(){t.onMonthChangeEnd("prev")}),a.animate||t.onMonthChangeEnd("prev")},t.prototype.resetMonth=function(e){void 0===e&&(e="");var t=this.$wrapperEl,a=this.inverter,r=this.isHorizontal,n=100*this.monthsTranslate*a;t.transition(e).transform("translate3d("+(r?n:0)+"%, "+(r?0:n)+"%, 0)")},t.prototype.setYearMonth=function(e,t,a){var r,n=this,i=n.params,s=n.isHorizontal,o=n.$wrapperEl,l=n.inverter;if(void 0===e&&(e=n.currentYear),void 0===t&&(t=n.currentMonth),void 0!==a&&"object"!=typeof a||(a="",i.animate||(a=0)),r=e<n.currentYear?new n.DateHandleClass(e,t+1,-1).getTime():new n.DateHandleClass(e,t).getTime(),i.maxDate&&r>new n.DateHandleClass(i.maxDate).getTime())return!1;if(i.minDate){var p=new n.DateHandleClass(i.minDate);if(r<(p=new n.DateHandleClass(p.getFullYear(),p.getMonth(),1)).getTime())return!1}var c=new n.DateHandleClass(n.currentYear,n.currentMonth).getTime(),d=r>c?"next":"prev",u=n.renderMonth(new n.DateHandleClass(e,t));n.monthsTranslate=n.monthsTranslate||0;var h,f=n.monthsTranslate,v=!n.animating;r>c?(n.monthsTranslate-=1,n.animating||n.$months.eq(n.$months.length-1).remove(),o.append(u),n.$months=o.find(".calendar-month"),h=100*-(f-1)*l,n.$months.eq(n.$months.length-1).transform("translate3d("+(s?h:0)+"%, "+(s?0:h)+"%, 0)").addClass("calendar-month-next")):(n.monthsTranslate+=1,n.animating||n.$months.eq(0).remove(),o.prepend(u),n.$months=o.find(".calendar-month"),h=100*-(f+1)*l,n.$months.eq(0).transform("translate3d("+(s?h:0)+"%, "+(s?0:h)+"%, 0)").addClass("calendar-month-prev")),n.emit("local::monthAdd calendarMonthAdd","next"===d?n.$months.eq(n.$months.length-1)[0]:n.$months.eq(0)[0]),n.animating=!0,n.onMonthChangeStart(d);var m=100*n.monthsTranslate*l;o.transition(a).transform("translate3d("+(s?m:0)+"%, "+(s?0:m)+"%, 0)"),v&&o.transitionEnd(function(){n.onMonthChangeEnd(d,!0)}),i.animate||n.onMonthChangeEnd(d)},t.prototype.nextYear=function(){this.setYearMonth(this.currentYear+1)},t.prototype.prevYear=function(){this.setYearMonth(this.currentYear-1)},t.prototype.dateInRange=function(e,t){var a,r=!1;if(!t)return!1;if(Array.isArray(t))for(a=0;a<t.length;a+=1)t[a].from||t[a].to?t[a].from&&t[a].to?e<=new this.DateHandleClass(t[a].to).getTime()&&e>=new this.DateHandleClass(t[a].from).getTime()&&(r=!0):t[a].from?e>=new this.DateHandleClass(t[a].from).getTime()&&(r=!0):t[a].to&&e<=new this.DateHandleClass(t[a].to).getTime()&&(r=!0):t[a].date?e===new this.DateHandleClass(t[a].date).getTime()&&(r=!0):e===new this.DateHandleClass(t[a]).getTime()&&(r=!0);else t.from||t.to?t.from&&t.to?e<=new this.DateHandleClass(t.to).getTime()&&e>=new this.DateHandleClass(t.from).getTime()&&(r=!0):t.from?e>=new this.DateHandleClass(t.from).getTime()&&(r=!0):t.to&&e<=new this.DateHandleClass(t.to).getTime()&&(r=!0):t.date?r=e===new this.DateHandleClass(t.date).getTime():"function"==typeof t&&(r=t(new this.DateHandleClass(e)));return r},t.prototype.daysInMonth=function(e){var t=new this.DateHandleClass(e);return new this.DateHandleClass(t.getFullYear(),t.getMonth()+1,0).getDate()},t.prototype.renderMonths=function(e){return this.params.renderMonths?this.params.renderMonths.call(this,e):('\n    <div class="calendar-months-wrapper">\n    '+this.renderMonth(e,"prev")+"\n    "+this.renderMonth(e)+"\n    "+this.renderMonth(e,"next")+"\n    </div>\n  ").trim()},t.prototype.renderMonth=function(e,t){var a=this,r=a.params,n=a.value;if(r.renderMonth)return r.renderMonth.call(a,e,t);var i=new a.DateHandleClass(e),s=i.getFullYear(),o=i.getMonth();"next"===t&&(i=11===o?new a.DateHandleClass(s+1,0):new a.DateHandleClass(s,o+1,1)),"prev"===t&&(i=0===o?new a.DateHandleClass(s-1,11):new a.DateHandleClass(s,o-1,1)),"next"!==t&&"prev"!==t||(o=i.getMonth(),s=i.getFullYear());var l,p,c=[],d=(new a.DateHandleClass).setHours(0,0,0,0),u=r.minDate?new a.DateHandleClass(r.minDate).getTime():null,h=r.maxDate?new a.DateHandleClass(r.maxDate).getTime():null,f=a.daysInMonth(new a.DateHandleClass(i.getFullYear(),i.getMonth()).getTime()-864e6),v=a.daysInMonth(i),m=6===r.firstDay?0:1,g="",b=r.firstDay-1+0,y=new a.DateHandleClass(i.getFullYear(),i.getMonth()).getDay();if(0===y&&(y=7),n&&n.length)for(var w=0;w<n.length;w+=1)c.push(new a.DateHandleClass(n[w]).setHours(0,0,0,0));for(var C=1;C<=6;C+=1){for(var x="",$=function(e){var t=void 0,n=(b+=1)-y,i="";1===C&&1===e&&n>m&&1!==r.firstDay&&(n=(b-=7)-y);var g=e-1+r.firstDay>6?e-1-7+r.firstDay:e-1+r.firstDay;n<0?(n=f+n+1,i+=" calendar-day-prev",t=new a.DateHandleClass(o-1<0?s-1:s,o-1<0?11:o-1,n).getTime()):(n+=1)>v?(n-=v,i+=" calendar-day-next",t=new a.DateHandleClass(o+1>11?s+1:s,o+1>11?0:o+1,n).getTime()):t=new a.DateHandleClass(s,o,n).getTime(),t===d&&(i+=" calendar-day-today"),r.rangePicker&&2===c.length?t>=c[0]&&t<=c[1]&&(i+=" calendar-day-selected"):c.indexOf(t)>=0&&(i+=" calendar-day-selected"),r.weekendDays.indexOf(g)>=0&&(i+=" calendar-day-weekend");var w="";if(p=!1,r.events&&a.dateInRange(t,r.events)&&(p=!0),p&&(i+=" calendar-day-has-events",w='\n            <span class="calendar-day-events">\n              <span class="calendar-day-event"></span>\n            </span>\n          ',Array.isArray(r.events))){var $=[];r.events.forEach(function(e){var r=e.color||"";$.indexOf(r)<0&&a.dateInRange(t,e)&&$.push(r)}),w='\n              <span class="calendar-day-events">\n                '+$.map(function(e){return('\n                  <span class="calendar-day-event" style="'+(e?"background-color: "+e:"")+'"></span>\n                ').trim()}).join("")+"\n              </span>\n            "}if(r.rangesClasses)for(var E=0;E<r.rangesClasses.length;E+=1)a.dateInRange(t,r.rangesClasses[E].range)&&(i+=" "+r.rangesClasses[E].cssClass);l=!1,(u&&t<u||h&&t>h)&&(l=!0),r.disabled&&a.dateInRange(t,r.disabled)&&(l=!0),l&&(i+=" calendar-day-disabled");var k=(t=new a.DateHandleClass(t)).getFullYear(),S=t.getMonth();x+=('\n          <div data-year="'+k+'" data-month="'+S+'" data-day="'+n+'" class="calendar-day'+i+'" data-date="'+k+"-"+S+"-"+n+'">\n            <span class="calendar-day-number">'+n+w+"</span>\n          </div>").trim()},E=1;E<=7;E+=1)$(E);g+='<div class="calendar-row">'+x+"</div>"}return g='<div class="calendar-month" data-year="'+s+'" data-month="'+o+'">'+g+"</div>"},t.prototype.renderWeekHeader=function(){if(this.params.renderWeekHeader)return this.params.renderWeekHeader.call(this);for(var e=this.params,t="",a=0;a<7;a+=1){var r=a+e.firstDay>6?a-7+e.firstDay:a+e.firstDay;t+='<div class="calendar-week-day">'+e.dayNamesShort[r]+"</div>"}return('\n    <div class="calendar-week-header">\n      '+t+"\n    </div>\n  ").trim()},t.prototype.renderMonthSelector=function(){return this.params.renderMonthSelector?this.params.renderMonthSelector.call(this):'\n    <div class="calendar-month-selector">\n      <a href="#" class="link icon-only calendar-prev-month-button">\n        <i class="icon icon-prev"></i>\n      </a>\n      <span class="current-month-value"></span>\n      <a href="#" class="link icon-only calendar-next-month-button">\n        <i class="icon icon-next"></i>\n      </a>\n    </div>\n  '.trim()},t.prototype.renderYearSelector=function(){return this.params.renderYearSelector?this.params.renderYearSelector.call(this):'\n    <div class="calendar-year-selector">\n      <a href="#" class="link icon-only calendar-prev-year-button">\n        <i class="icon icon-prev"></i>\n      </a>\n      <span class="current-year-value"></span>\n      <a href="#" class="link icon-only calendar-next-year-button">\n        <i class="icon icon-next"></i>\n      </a>\n    </div>\n  '.trim()},t.prototype.renderHeader=function(){return this.params.renderHeader?this.params.renderHeader.call(this):('\n    <div class="calendar-header">\n      <div class="calendar-selected-date">'+this.params.headerPlaceholder+"</div>\n    </div>\n  ").trim()},t.prototype.renderFooter=function(){var e=this.app;return this.params.renderFooter?this.params.renderFooter.call(this):('\n    <div class="calendar-footer">\n      <a href="#" class="'+("md"===e.theme?"button":"link")+' calendar-close sheet-close popover-close">'+this.params.toolbarCloseText+"</a>\n    </div>\n  ").trim()},t.prototype.renderToolbar=function(){return this.params.renderToolbar?this.params.renderToolbar.call(this,this):('\n    <div class="toolbar toolbar-top no-shadow">\n      <div class="toolbar-inner">\n        '+(this.params.monthSelector?this.renderMonthSelector():"")+"\n        "+(this.params.yearSelector?this.renderYearSelector():"")+"\n      </div>\n    </div>\n  ").trim()},t.prototype.renderInline=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,n=e.footer,i=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="calendar calendar-inline '+(i?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(n?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderCustomModal=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,n=e.footer,i=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="calendar calendar-modal '+(i?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(n?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderSheet=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,n=e.footer,i=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="sheet-modal calendar calendar-sheet '+(i?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="sheet-modal-inner calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(n?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderPopover=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,n=e.footer,i=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="popover calendar-popover">\n      <div class="popover-inner">\n        <div class="calendar '+(i?"calendar-range":"")+" "+(t||"")+'">\n        '+(r?this.renderHeader():"")+"\n        "+(a?this.renderToolbar():"")+"\n        "+(s?this.renderWeekHeader():"")+'\n        <div class="calendar-months">\n          '+this.renderMonths(l)+"\n        </div>\n        "+(n?this.renderFooter():"")+"\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.render=function(){var e=this.params;if(e.render)return e.render.call(this);if(!this.inline){var t=e.openIn;return"auto"===t&&(t=this.isPopover()?"popover":"sheet"),"popover"===t?this.renderPopover():"sheet"===t?this.renderSheet():this.renderCustomModal()}return this.renderInline()},t.prototype.onOpen=function(){var e=this,t=e.initialized,a=e.$el,r=e.app,n=e.$inputEl,i=e.inline,s=e.value,o=e.params;e.closing=!1,e.opened=!0,e.opening=!0,e.attachCalendarEvents();var l=!s&&o.value;t?s&&e.setValue(s,0):s?e.setValue(s,0):o.value&&e.setValue(e.normalizeValues(o.value),0),e.updateCurrentMonthYear(),e.monthsTranslate=0,e.setMonthsTranslate(),l?e.updateValue():o.header&&s&&e.updateValue(!0),!i&&n&&n.length&&"md"===r.theme&&n.trigger("focus"),e.initialized=!0,e.$months.each(function(t,a){e.emit("local::monthAdd calendarMonthAdd",a)}),a&&a.trigger("calendar:open",e),n&&n.trigger("calendar:open",e),e.emit("local::open calendarOpen",e)},t.prototype.onOpened=function(){this.opening=!1,this.$el&&this.$el.trigger("calendar:opened",this),this.$inputEl&&this.$inputEl.trigger("calendar:opened",this),this.emit("local::opened calendarOpened",this)},t.prototype.onClose=function(){var e=this.app;this.opening=!1,this.closing=!0,this.$inputEl&&"md"===e.theme&&this.$inputEl.trigger("blur"),this.detachCalendarEvents&&this.detachCalendarEvents(),this.$el&&this.$el.trigger("calendar:close",this),this.$inputEl&&this.$inputEl.trigger("calendar:close",this),this.emit("local::close calendarClose",this)},t.prototype.onClosed=function(){var e=this;e.opened=!1,e.closing=!1,e.inline||Utils.nextTick(function(){e.modal&&e.modal.el&&e.modal.destroy&&(e.params.routableModals||e.modal.destroy()),delete e.modal}),e.$el&&e.$el.trigger("calendar:closed",e),e.$inputEl&&e.$inputEl.trigger("calendar:closed",e),e.emit("local::closed calendarClosed",e)},t.prototype.open=function(){var e,t=this,a=t.app,r=t.opened,n=t.inline,i=t.$inputEl,s=t.params;if(!r){if(n)return t.$el=$(t.render()),t.$el[0].f7Calendar=t,t.$wrapperEl=t.$el.find(".calendar-months-wrapper"),t.$months=t.$wrapperEl.find(".calendar-month"),t.$containerEl.append(t.$el),t.onOpen(),void t.onOpened();var o=s.openIn;"auto"===o&&(o=t.isPopover()?"popover":"sheet");var l=t.render(),p={targetEl:i,scrollToEl:t.params.scrollToInput?i:void 0,content:l,backdrop:!0===t.params.backdrop||"popover"===o&&!1!==a.params.popover.backdrop&&!1!==t.params.backdrop,closeByBackdropClick:t.params.closeByBackdropClick,on:{open:function(){t.modal=this,t.$el="popover"===o?this.$el.find(".calendar"):this.$el,t.$wrapperEl=t.$el.find(".calendar-months-wrapper"),t.$months=t.$wrapperEl.find(".calendar-month"),t.$el[0].f7Calendar=t,"customModal"===o&&$(t.$el).find(".calendar-close").once("click",function(){t.close()}),t.onOpen()},opened:function(){t.onOpened()},close:function(){t.onClose()},closed:function(){t.onClosed()}}};t.params.routableModals?t.view.router.navigate({url:t.url,route:(e={path:t.url},e[o]=p,e)}):(t.modal=a[o].create(p),t.modal.open())}},t.prototype.close=function(){var e=this.opened,t=this.inline;if(e)return t?(this.onClose(),void this.onClosed()):void(this.params.routableModals?this.view.router.back():this.modal.close())},t.prototype.init=function(){if(this.initInput(),this.inline)return this.open(),void this.emit("local::init calendarInit",this);!this.initialized&&this.params.value&&this.setValue(this.normalizeValues(this.params.value)),this.$inputEl&&this.attachInputEvents(),this.params.closeByOutsideClick&&this.attachHtmlEvents(),this.emit("local::init calendarInit",this)},t.prototype.destroy=function(){if(!this.destroyed){var e=this.$el;this.emit("local::beforeDestroy calendarBeforeDestroy",this),e&&e.trigger("calendar:beforedestroy",this),this.close(),this.$inputEl&&this.detachInputEvents(),this.params.closeByOutsideClick&&this.detachHtmlEvents(),e&&e.length&&delete this.$el[0].f7Calendar,Utils.deleteProps(this),this.destroyed=!0}},t}(Framework7Class),Calendar$1={name:"calendar",static:{Calendar:Calendar},create:function(){this.calendar=ConstructorMethods({defaultSelector:".calendar",constructor:Calendar,app:this,domProp:"f7Calendar"}),this.calendar.close=function(e){void 0===e&&(e=".calendar");var t=$(e);if(0!==t.length){var a=t[0].f7Calendar;!a||a&&!a.opened||a.close()}}},params:{calendar:{calendarType:"gregorian",monthNames:["January","February","March","April","May","June","July","August","September","October","November","December"],monthNamesShort:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],dayNames:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],dayNamesShort:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],firstDay:1,weekendDays:[0,6],jalali:{monthNames:["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"],monthNamesShort:["فَر","اُر","خُر","تیر","مُر","شَه","مهر","آب","آذر","دی","بَه","اِس"],dayNames:["یک‌شنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنج‌شنبه","جمعه","شنبه"],dayNamesShort:["1ش","۲ش","۳ش","۴ش","۵ش","ج","ش"],firstDay:6,weekendDays:[5]},multiple:!1,rangePicker:!1,rangePickerMinDays:1,rangePickerMaxDays:0,dateFormat:"yyyy-mm-dd",direction:"horizontal",minDate:null,maxDate:null,disabled:null,events:null,rangesClasses:null,touchMove:!0,animate:!0,closeOnSelect:!1,monthSelector:!0,yearSelector:!0,weekHeader:!0,value:null,containerEl:null,openIn:"auto",formatValue:null,inputEl:null,inputReadOnly:!0,closeByOutsideClick:!0,scrollToInput:!0,header:!1,headerPlaceholder:"Select date",footer:!1,toolbar:!0,toolbarCloseText:"Done",cssClass:null,routableModals:!0,view:null,url:"date/",backdrop:null,closeByBackdropClick:!0,renderWeekHeader:null,renderMonths:null,renderMonth:null,renderMonthSelector:null,renderYearSelector:null,renderHeader:null,renderFooter:null,renderToolbar:null,renderInline:null,renderPopover:null,renderSheet:null,render:null}}};function pickerColumn(e,t){var a=this,r=a.app,n=$(e),i=n.index(),s=a.cols[i];if(!s.divider){var o,l,p,c,d;s.$el=n,s.el=n[0],s.$itemsEl=s.$el.find(".picker-items"),s.items=s.$itemsEl.find(".picker-item"),s.replaceValues=function(e,t){s.detachEvents(),s.values=e,s.displayValues=t,s.$itemsEl.html(a.renderColumn(s,!0)),s.items=s.$itemsEl.find(".picker-item"),s.calcSize(),s.setValue(s.values[0],0,!0),s.attachEvents()},s.calcSize=function(){a.params.rotateEffect&&(s.$el.removeClass("picker-column-absolute"),s.width||s.$el.css({width:""}));var e=0,t=s.$el[0].offsetHeight;o=s.items[0].offsetHeight,l=o*s.items.length,p=t/2-l+o/2,c=t/2-o/2,s.width&&(e=s.width,parseInt(e,10)===e&&(e+="px"),s.$el.css({width:e})),a.params.rotateEffect&&(s.width||(s.items.each(function(t,a){var r=$(a).children("span");e=Math.max(e,r[0].offsetWidth)}),s.$el.css({width:e+2+"px"})),s.$el.addClass("picker-column-absolute"))},s.setValue=function(e,t,r){void 0===t&&(t="");var n=s.$itemsEl.find('.picker-item[data-picker-value="'+e+'"]').index();if(void 0!==n&&-1!==n){var i=-n*o+c;s.$itemsEl.transition(t),s.$itemsEl.transform("translate3d(0,"+i+"px,0)"),a.params.updateValuesOnMomentum&&s.activeIndex&&s.activeIndex!==n&&(Utils.cancelAnimationFrame(d),s.$itemsEl.transitionEnd(function(){Utils.cancelAnimationFrame(d)}),S()),s.updateItems(n,i,t,r)}},s.updateItems=function(e,t,r,n){void 0===t&&(t=Utils.getTranslate(s.$itemsEl[0],"y")),void 0===e&&(e=-Math.round((t-c)/o)),e<0&&(e=0),e>=s.items.length&&(e=s.items.length-1);var i=s.activeIndex;s.activeIndex=e,s.$itemsEl.find(".picker-item-selected").removeClass("picker-item-selected"),s.items.transition(r);var l=s.items.eq(e).addClass("picker-item-selected").transform("");a.params.rotateEffect&&s.items.each(function(e,r){var n=$(r),i=(n.index()*o-(c-t))/o,l=Math.ceil(s.height/o/2)+1,p=-18*i;p>180&&(p=180),p<-180&&(p=-180),Math.abs(i)>l?n.addClass("picker-item-far"):n.removeClass("picker-item-far"),n.transform("translate3d(0, "+(-t+c)+"px, "+(a.needsOriginFix?-110:0)+"px) rotateX("+p+"deg)")}),(n||void 0===n)&&(s.value=l.attr("data-picker-value"),s.displayValue=s.displayValues?s.displayValues[e]:s.value,i!==e&&(s.onChange&&s.onChange(a,s.value,s.displayValue),a.updateValue()))};var u,h,f,v,m,g,b,y,w,C,x,E=!0,k=!!r.support.passiveListener&&{passive:!1,capture:!1};s.attachEvents=function(){s.$el.on(r.touchEvents.start,T,k),r.on("touchmove:active",M),r.on("touchend:passive",P),a.params.mousewheel&&s.$el.on("wheel",O),s.items.on("click",D)},s.detachEvents=function(){s.$el.off(r.touchEvents.start,T,k),r.off("touchmove:active",M),r.off("touchend:passive",P),a.params.mousewheel&&s.$el.off("wheel",O),s.items.off("click",D)},s.init=function(){s.calcSize(),s.$itemsEl.transform("translate3d(0,"+c+"px,0)").transition(0),0===i&&s.$el.addClass("picker-column-first"),i===a.cols.length-1&&s.$el.addClass("picker-column-last"),t&&s.updateItems(0,c,0),s.attachEvents()},s.destroy=function(){s.detachEvents()},s.init()}function S(){d=Utils.requestAnimationFrame(function(){s.updateItems(void 0,void 0,0),S()})}function T(e){h||u||(e.preventDefault(),u=!0,f="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,v=f,m=(new Date).getTime(),E=!0,g=Utils.getTranslate(s.$itemsEl[0],"y"),y=g)}function M(e){u&&(e.preventDefault(),E=!1,v="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,h||(Utils.cancelAnimationFrame(d),h=!0,g=Utils.getTranslate(s.$itemsEl[0],"y"),y=g,s.$itemsEl.transition(0)),b=void 0,(y=g+(v-f))<p&&(y=p-Math.pow(p-y,.8),b="min"),y>c&&(y=c+Math.pow(y-c,.8),b="max"),s.$itemsEl.transform("translate3d(0,"+y+"px,0)"),s.updateItems(void 0,y,0,a.params.updateValuesOnTouchmove),C=y-w||y,w=y)}function P(){if(!u||!h)return u=!1,void(h=!1);var e;u=!1,h=!1,s.$itemsEl.transition(""),b&&("min"===b?s.$itemsEl.transform("translate3d(0,"+p+"px,0)"):s.$itemsEl.transform("translate3d(0,"+c+"px,0)")),e=(new Date).getTime()-m>300?y:y+C*a.params.momentumRatio,e=Math.max(Math.min(e,c),p);var t=Math.round(Math.abs((e-c)/o));a.params.freeMode||(e=-t*o+c),s.$itemsEl.transform("translate3d(0,"+parseInt(e,10)+"px,0)"),s.updateItems(t,e,"",!0),a.params.updateValuesOnMomentum&&(S(),s.$itemsEl.transitionEnd(function(){Utils.cancelAnimationFrame(d)})),setTimeout(function(){E=!0},100)}function O(e){var t=e.deltaX,r=e.deltaY;Math.abs(t)>Math.abs(r)||(clearTimeout(x),e.preventDefault(),Utils.cancelAnimationFrame(d),g=Utils.getTranslate(s.$itemsEl[0],"y"),s.$itemsEl.transition(0),b=void 0,(y=g-r)<p&&(y=p,b="min"),y>c&&(y=c,b="max"),s.$itemsEl.transform("translate3d(0,"+y+"px,0)"),s.updateItems(void 0,y,0,a.params.updateValuesOnMousewheel),x=setTimeout(function(){s.$itemsEl.transition(""),b&&("min"===b?s.$itemsEl.transform("translate3d(0,"+p+"px,0)"):s.$itemsEl.transform("translate3d(0,"+c+"px,0)")),(new Date).getTime();var e=y;e=Math.max(Math.min(e,c),p);var t=Math.round(Math.abs((e-c)/o));a.params.freeMode||(e=-t*o+c),s.$itemsEl.transform("translate3d(0,"+parseInt(e,10)+"px,0)"),s.updateItems(t,e,"",!0)},200))}function D(){if(E){Utils.cancelAnimationFrame(d);var e=$(this).attr("data-picker-value");s.setValue(e)}}}var Picker=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,n,i,s=this;if(s.params=Utils.extend({},t.params.picker,a),s.params.containerEl&&0===(r=$(s.params.containerEl)).length)return s;function o(){s.resizeCols()}function l(){s.open()}function p(e){e.preventDefault()}function c(e){var t=$(e.target);s.isPopover()||s.opened&&!s.closing&&(t.closest('[class*="backdrop"]').length||(n&&n.length>0?t[0]!==n[0]&&0===t.closest(".sheet-modal").length&&s.close():0===$(e.target).closest(".sheet-modal").length&&s.close()))}return s.params.inputEl&&(n=$(s.params.inputEl)),n&&(i=n.parents(".view").length&&n.parents(".view")[0].f7View),i||(i=t.views.main),Utils.extend(s,{app:t,$containerEl:r,containerEl:r&&r[0],inline:r&&r.length>0,needsOriginFix:t.device.ios||win.navigator.userAgent.toLowerCase().indexOf("safari")>=0&&win.navigator.userAgent.toLowerCase().indexOf("chrome")<0&&!t.device.android,cols:[],$inputEl:n,inputEl:n&&n[0],initialized:!1,opened:!1,url:s.params.url,view:i}),Utils.extend(s,{attachResizeEvent:function(){t.on("resize",o)},detachResizeEvent:function(){t.off("resize",o)},attachInputEvents:function(){s.$inputEl.on("click",l),s.params.inputReadOnly&&s.$inputEl.on("focus mousedown",p)},detachInputEvents:function(){s.$inputEl.off("click",l),s.params.inputReadOnly&&s.$inputEl.off("focus mousedown",p)},attachHtmlEvents:function(){t.on("click",c)},detachHtmlEvents:function(){t.off("click",c)}}),s.init(),s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.initInput=function(){this.$inputEl&&this.params.inputReadOnly&&this.$inputEl.prop("readOnly",!0)},t.prototype.resizeCols=function(){if(this.opened)for(var e=0;e<this.cols.length;e+=1)this.cols[e].divider||(this.cols[e].calcSize(),this.cols[e].setValue(this.cols[e].value,0,!1))},t.prototype.isPopover=function(){var e=this.app,t=this.modal,a=this.params;if("sheet"===a.openIn)return!1;if(t&&"popover"!==t.type)return!1;if(!this.inline&&this.inputEl){if("popover"===a.openIn)return!0;if(e.device.ios)return!!e.device.ipad;if(e.width>=768)return!0;if(e.device.desktop&&"aurora"===e.theme)return!0}return!1},t.prototype.formatValue=function(){var e=this.value,t=this.displayValue;return this.params.formatValue?this.params.formatValue.call(this,e,t):e.join(" ")},t.prototype.setValue=function(e,t){var a=0;if(0===this.cols.length)return this.value=e,void this.updateValue(e);for(var r=0;r<this.cols.length;r+=1)this.cols[r]&&!this.cols[r].divider&&(this.cols[r].setValue(e[a],t),a+=1)},t.prototype.getValue=function(){return this.value},t.prototype.updateValue=function(e){var t,a=e||[],r=[];if(0===this.cols.length)for(var n=this.params.cols.filter(function(e){return!e.divider}),i=0;i<n.length;i+=1)void 0!==(t=n[i]).displayValues&&void 0!==t.values&&-1!==t.values.indexOf(a[i])?r.push(t.displayValues[t.values.indexOf(a[i])]):r.push(a[i]);else for(var s=0;s<this.cols.length;s+=1)this.cols[s].divider||(a.push(this.cols[s].value),r.push(this.cols[s].displayValue));a.indexOf(void 0)>=0||(this.value=a,this.displayValue=r,this.emit("local::change pickerChange",this,this.value,this.displayValue),this.inputEl&&(this.$inputEl.val(this.formatValue()),this.$inputEl.trigger("change")))},t.prototype.initColumn=function(e,t){pickerColumn.call(this,e,t)},t.prototype.destroyColumn=function(e){var t=$(e).index();this.cols[t]&&this.cols[t].destroy&&this.cols[t].destroy()},t.prototype.renderToolbar=function(){return this.params.renderToolbar?this.params.renderToolbar.call(this,this):('\n      <div class="toolbar toolbar-top no-shadow">\n        <div class="toolbar-inner">\n          <div class="left"></div>\n          <div class="right">\n            <a href="#" class="link sheet-close popover-close">'+this.params.toolbarCloseText+"</a>\n          </div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderColumn=function(e,t){var a,r,n="picker-column "+(e.textAlign?"picker-column-"+e.textAlign:"")+" "+(e.cssClass||"");return a=e.divider?'\n        <div class="'+n+' picker-column-divider">'+e.content+"</div>\n      ":'\n        <div class="'+n+'">\n          <div class="picker-items">'+(r=e.values.map(function(t,a){return'\n        <div class="picker-item" data-picker-value="'+t+'">\n          <span>'+(e.displayValues?e.displayValues[a]:t)+"</span>\n        </div>\n      "}).join(""))+"</div>\n        </div>\n      ",t?r.trim():a.trim()},t.prototype.renderInline=function(){var e=this,t=e.params;return('\n      <div class="picker picker-inline '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n        '+(t.toolbar?e.renderToolbar():"")+'\n        <div class="picker-columns">\n          '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n          <div class="picker-center-highlight"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderSheet=function(){var e=this,t=e.params;return('\n      <div class="sheet-modal picker picker-sheet '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n        '+(t.toolbar?e.renderToolbar():"")+'\n        <div class="sheet-modal-inner picker-columns">\n          '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n          <div class="picker-center-highlight"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderPopover=function(){var e=this,t=e.params;return('\n      <div class="popover picker-popover">\n        <div class="popover-inner">\n          <div class="picker '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n            '+(t.toolbar?e.renderToolbar():"")+'\n            <div class="picker-columns">\n              '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n              <div class="picker-center-highlight"></div>\n            </div>\n          </div>\n        </div>\n      </div>\n    ').trim()},t.prototype.render=function(){return this.params.render?this.params.render.call(this):this.inline?this.renderInline():this.isPopover()?this.renderPopover():this.renderSheet()},t.prototype.onOpen=function(){var e=this,t=e.initialized,a=e.$el,r=e.app,n=e.$inputEl,i=e.inline,s=e.value,o=e.params;e.opened=!0,e.closing=!1,e.opening=!0,e.attachResizeEvent(),a.find(".picker-column").each(function(a,r){var n=!0;(!t&&o.value||t&&s)&&(n=!1),e.initColumn(r,n)}),t?s&&e.setValue(s,0):s?e.setValue(s,0):o.value&&e.setValue(o.value,0),!i&&n&&n.length&&"md"===r.theme&&n.trigger("focus"),e.initialized=!0,a&&a.trigger("picker:open",e),n&&n.trigger("picker:open",e),e.emit("local::open pickerOpen",e)},t.prototype.onOpened=function(){this.opening=!1,this.$el&&this.$el.trigger("picker:opened",this),this.$inputEl&&this.$inputEl.trigger("picker:opened",this),this.emit("local::opened pickerOpened",this)},t.prototype.onClose=function(){var e=this.app;this.opening=!1,this.closing=!0,this.detachResizeEvent(),this.cols.forEach(function(e){e.destroy&&e.destroy()}),this.$inputEl&&"md"===e.theme&&this.$inputEl.trigger("blur"),this.$el&&this.$el.trigger("picker:close",this),this.$inputEl&&this.$inputEl.trigger("picker:close",this),this.emit("local::close pickerClose",this)},t.prototype.onClosed=function(){var e=this;e.opened=!1,e.closing=!1,e.inline||Utils.nextTick(function(){e.modal&&e.modal.el&&e.modal.destroy&&(e.params.routableModals||e.modal.destroy()),delete e.modal}),e.$el&&e.$el.trigger("picker:closed",e),e.$inputEl&&e.$inputEl.trigger("picker:closed",e),e.emit("local::closed pickerClosed",e)},t.prototype.open=function(){var e,t=this,a=t.app,r=t.opened,n=t.inline,i=t.$inputEl;if(!r){if(0===t.cols.length&&t.params.cols.length&&t.params.cols.forEach(function(e){t.cols.push(e)}),n)return t.$el=$(t.render()),t.$el[0].f7Picker=t,t.$containerEl.append(t.$el),t.onOpen(),void t.onOpened();var s=t.isPopover(),o=s?"popover":"sheet",l={targetEl:i,scrollToEl:t.params.scrollToInput?i:void 0,content:t.render(),backdrop:s,on:{open:function(){t.modal=this,t.$el=s?this.$el.find(".picker"):this.$el,t.$el[0].f7Picker=t,t.onOpen()},opened:function(){t.onOpened()},close:function(){t.onClose()},closed:function(){t.onClosed()}}};t.params.routableModals?t.view.router.navigate({url:t.url,route:(e={path:t.url},e[o]=l,e)}):(t.modal=a[o].create(l),t.modal.open())}},t.prototype.close=function(){var e=this.opened,t=this.inline;if(e)return t?(this.onClose(),void this.onClosed()):void(this.params.routableModals?this.view.router.back():this.modal.close())},t.prototype.init=function(){if(this.initInput(),this.inline)return this.open(),void this.emit("local::init pickerInit",this);!this.initialized&&this.params.value&&this.setValue(this.params.value),this.$inputEl&&this.attachInputEvents(),this.params.closeByOutsideClick&&this.attachHtmlEvents(),this.emit("local::init pickerInit",this)},t.prototype.destroy=function(){if(!this.destroyed){var e=this.$el;this.emit("local::beforeDestroy pickerBeforeDestroy",this),e&&e.trigger("picker:beforedestroy",this),this.close(),this.$inputEl&&this.detachInputEvents(),this.params.closeByOutsideClick&&this.detachHtmlEvents(),e&&e.length&&delete this.$el[0].f7Picker,Utils.deleteProps(this),this.destroyed=!0}},t}(Framework7Class),Picker$1={name:"picker",static:{Picker:Picker},create:function(){this.picker=ConstructorMethods({defaultSelector:".picker",constructor:Picker,app:this,domProp:"f7Picker"}),this.picker.close=function(e){void 0===e&&(e=".picker");var t=$(e);if(0!==t.length){var a=t[0].f7Picker;!a||a&&!a.opened||a.close()}}},params:{picker:{updateValuesOnMomentum:!1,updateValuesOnTouchmove:!0,updateValuesOnMousewheel:!0,mousewheel:!0,rotateEffect:!1,momentumRatio:7,freeMode:!1,cols:[],containerEl:null,openIn:"auto",formatValue:null,inputEl:null,inputReadOnly:!0,closeByOutsideClick:!0,scrollToInput:!0,toolbar:!0,toolbarCloseText:"Done",cssClass:null,routableModals:!0,view:null,url:"select/",renderToolbar:null,render:null}}},InfiniteScroll={handleScroll:function(e,t){var a,r=$(e),n=r[0].scrollTop,i=r[0].scrollHeight,s=r[0].offsetHeight,o=r[0].getAttribute("data-infinite-distance"),l=r.find(".virtual-list"),p=r.hasClass("infinite-scroll-top");if(o||(o=50),"string"==typeof o&&o.indexOf("%")>=0&&(o=parseInt(o,10)/100*s),o>s&&(o=s),p)n<o&&(r.trigger("infinite",t),this.emit("infinite",r[0],t));else if(n+s>=i-o){if(l.length>0&&(a=l.eq(-1)[0].f7VirtualList)&&!a.reachEnd&&!a.params.updatableScroll)return;r.trigger("infinite",t),this.emit("infinite",r[0],t)}},create:function(e){var t=$(e),a=this;t.on("scroll",function(e){a.infiniteScroll.handle(this,e)})},destroy:function(e){$(e).off("scroll")}},InfiniteScroll$1={name:"infiniteScroll",create:function(){Utils.extend(this,{infiniteScroll:{handle:InfiniteScroll.handleScroll.bind(this),create:InfiniteScroll.create.bind(this),destroy:InfiniteScroll.destroy.bind(this)}})},on:{tabMounted:function(e){var t=this;$(e).find(".infinite-scroll-content").each(function(e,a){t.infiniteScroll.create(a)})},tabBeforeRemove:function(e){var t=$(e),a=this;t.find(".infinite-scroll-content").each(function(e,t){a.infiniteScroll.destroy(t)})},pageInit:function(e){var t=this;e.$el.find(".infinite-scroll-content").each(function(e,a){t.infiniteScroll.create(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".infinite-scroll-content").each(function(e,a){t.infiniteScroll.destroy(a)})}}},PullToRefresh=function(e){function t(t,a){e.call(this,{},[t]);var r=this,n=$(a),i=n.find(".ptr-preloader");r.$el=n,r.el=n[0],r.app=t,r.bottom=r.$el.hasClass("ptr-bottom"),r.useModulesParams({});var s,o,l,p="md"===t.theme,c="ios"===t.theme,d="aurora"===t.theme;r.done=function(){return(p?i:n).transitionEnd(function(){n.removeClass("ptr-transitioning ptr-pull-up ptr-pull-down"),n.trigger("ptr:done"),r.emit("local::done ptrDone",n[0])}),n.removeClass("ptr-refreshing").addClass("ptr-transitioning"),r},r.refresh=function(){return n.hasClass("ptr-refreshing")?r:(n.addClass("ptr-transitioning ptr-refreshing"),n.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",n[0],r.done),r)},r.mousewheel="true"===n.attr("data-ptr-mousewheel");var u,h,f,v,m,g,b,y,w,C,x,E,k,S={},T=!1,M=!1,P=!1,O=0,D=!1,I=n.parents(".page");function B(e){if(o){if("android"!==Device.os)return;if("targetTouches"in e&&e.targetTouches.length>1)return}n.hasClass("ptr-refreshing")||$(e.target).closest(".sortable-handler, .ptr-ignore, .card-expandable.card-opened").length||(l=!1,y=!1,o=!0,u=void 0,m=void 0,"touchstart"===e.type&&(s=e.targetTouches[0].identifier),S.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,S.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY)}function R(e){if(o){var t,c,d;if("touchmove"===e.type){if(s&&e.touches)for(var E=0;E<e.touches.length;E+=1)e.touches[E].identifier===s&&(d=e.touches[E]);d||(d=e.targetTouches[0]),t=d.pageX,c=d.pageY}else t=e.pageX,c=e.pageY;if(t&&c)if(void 0===u&&(u=!!(u||Math.abs(c-S.y)>Math.abs(t-S.x))),u){if(v=n[0].scrollTop,!l){var k;if(n.removeClass("ptr-transitioning"),w=n[0].scrollHeight,C=n[0].offsetHeight,r.bottom&&(x=w-C),v>w)return void(o=!1);var D=$(e.target).closest(".ptr-watch-scroll");if(D.length&&D.each(function(e,t){t!==a&&t.scrollHeight>t.offsetHeight&&"auto"===$(t).css("overflow")&&(!r.bottom&&t.scrollTop>0||r.bottom&&t.scrollTop<t.scrollHeight-t.offsetHeight)&&(k=!0)}),k)return void(o=!1);b&&(g=n.attr("data-ptr-distance")).indexOf("%")>=0&&(g=w*parseInt(g,10)/100),O=n.hasClass("ptr-refreshing")?g:0,M=!(w!==C&&"ios"===Device.os&&!p),P=!1}l=!0,h=c-S.y,void 0===m&&(r.bottom?v!==x:0!==v)&&(m=!0),(r.bottom?h<0&&v>=x||v>x:h>0&&v<=0||v<0)?("ios"===Device.os&&parseInt(Device.osVersion.split(".")[0],10)>7&&(r.bottom||0!==v||m||(M=!0),r.bottom&&v===x&&!m&&(M=!0)),M||!r.bottom||p||(n.css("-webkit-overflow-scrolling","auto"),n.scrollTop(x),P=!0),(M||P)&&(e.cancelable&&e.preventDefault(),f=(r.bottom?-1*Math.pow(Math.abs(h),.85):Math.pow(h,.85))+O,p?i.transform("translate3d(0,"+f+"px,0)").find(".ptr-arrow").transform("rotate("+(Math.abs(h)/66*180+100)+"deg)"):r.bottom?n.children().transform("translate3d(0,"+f+"px,0)"):n.transform("translate3d(0,"+f+"px,0)")),(M||P)&&Math.pow(Math.abs(h),.85)>g||!M&&Math.abs(h)>=2*g?(T=!0,n.addClass("ptr-pull-up").removeClass("ptr-pull-down")):(T=!1,n.removeClass("ptr-pull-up").addClass("ptr-pull-down")),y||(n.trigger("ptr:pullstart"),r.emit("local::pullStart ptrPullStart",n[0]),y=!0),n.trigger("ptr:pullmove",{event:e,scrollTop:v,translate:f,touchesDiff:h}),r.emit("local::pullMove ptrPullMove",n[0],{event:e,scrollTop:v,translate:f,touchesDiff:h})):(y=!1,n.removeClass("ptr-pull-up ptr-pull-down"),T=!1)}else o=!1}}function L(e){return"touchend"===e.type&&e.changedTouches&&e.changedTouches.length>0&&s&&e.changedTouches[0].identifier!==s?(o=!1,u=!1,l=!1,void(s=null)):o&&l?(f&&(n.addClass("ptr-transitioning"),f=0),p?i.transform("").find(".ptr-arrow").transform(""):r.bottom?n.children().transform(""):n.transform(""),M||!r.bottom||p||n.css("-webkit-overflow-scrolling",""),T?(n.addClass("ptr-refreshing"),n.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",n[0],r.done)):n.removeClass("ptr-pull-down"),o=!1,l=!1,void(y&&(n.trigger("ptr:pullend"),r.emit("local::pullEnd ptrPullEnd",n[0])))):(o=!1,void(l=!1))}(I.find(".navbar").length>0||I.parents(".view").children(".navbar").length>0)&&(D=!0),I.hasClass("no-navbar")&&(D=!1),D||r.bottom||n.addClass("ptr-no-navbar"),n.attr("data-ptr-distance")?b=!0:p?g=66:c?g=44:d&&(g=38);var A=!0,z=0;function H(){A=!0,k=!1,z=0,f&&(n.addClass("ptr-transitioning"),f=0),p?i.transform("").find(".ptr-arrow").transform(""):r.bottom?n.children().transform(""):n.transform(""),T?(n.addClass("ptr-refreshing"),n.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",n[0],r.done)):n.removeClass("ptr-pull-down"),y&&(n.trigger("ptr:pullend"),r.emit("local::pullEnd ptrPullEnd",n[0]))}function U(e){if(A){var t=e.deltaX,s=e.deltaY;if(!(Math.abs(t)>Math.abs(s)||n.hasClass("ptr-refreshing")||$(e.target).closest(".sortable-handler, .ptr-ignore, .card-expandable.card-opened").length)){if(clearTimeout(E),v=n[0].scrollTop,!k){var o;if(n.removeClass("ptr-transitioning"),w=n[0].scrollHeight,C=n[0].offsetHeight,r.bottom&&(x=w-C),v>w)return void(A=!1);var c=$(e.target).closest(".ptr-watch-scroll");if(c.length&&c.each(function(e,t){t!==a&&t.scrollHeight>t.offsetHeight&&"auto"===$(t).css("overflow")&&(!r.bottom&&t.scrollTop>0||r.bottom&&t.scrollTop<t.scrollHeight-t.offsetHeight)&&(o=!0)}),o)return void(A=!1);b&&(g=n.attr("data-ptr-distance")).indexOf("%")>=0&&(g=w*parseInt(g,10)/100)}l=!0,h=z-=s,void 0===m&&(r.bottom?v!==x:0!==v)&&(m=!0),(r.bottom?h<0&&v>=x||v>x:h>0&&v<=0||v<0)?(e.cancelable&&e.preventDefault(),f=h,Math.abs(f)>g&&(f=g+Math.pow(Math.abs(f)-g,.7),r.bottom&&(f=-f)),p?i.transform("translate3d(0,"+f+"px,0)").find(".ptr-arrow").transform("rotate("+(Math.abs(h)/66*180+100)+"deg)"):r.bottom?n.children().transform("translate3d(0,"+f+"px,0)"):n.transform("translate3d(0,"+f+"px,0)"),Math.abs(f)>g?(T=!0,n.addClass("ptr-pull-up").removeClass("ptr-pull-down")):(T=!1,n.removeClass("ptr-pull-up").addClass("ptr-pull-down")),y||(n.trigger("ptr:pullstart"),r.emit("local::pullStart ptrPullStart",n[0]),y=!0),n.trigger("ptr:pullmove",{event:e,scrollTop:v,translate:f,touchesDiff:h}),r.emit("local::pullMove ptrPullMove",n[0],{event:e,scrollTop:v,translate:f,touchesDiff:h})):(y=!1,n.removeClass("ptr-pull-up ptr-pull-down"),T=!1),E=setTimeout(H,300)}}}return I.length&&n.length?(n[0].f7PullToRefresh=r,r.attachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};n.on(t.touchEvents.start,B,e),t.on("touchmove:active",R),t.on("touchend:passive",L),r.mousewheel&&!r.bottom&&n.on("wheel",U)},r.detachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};n.off(t.touchEvents.start,B,e),t.off("touchmove:active",R),t.off("touchend:passive",L),r.mousewheel&&!r.bottom&&n.off("wheel",U)},r.useModules(),r.init(),r):r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy ptrBeforeDestroy",e),e.$el.trigger("ptr:beforedestroy",e),delete e.el.f7PullToRefresh,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),PullToRefresh$1={name:"pullToRefresh",create:function(){var e=this;e.ptr=Utils.extend(ConstructorMethods({defaultSelector:".ptr-content",constructor:PullToRefresh,app:e,domProp:"f7PullToRefresh"}),{done:function(t){var a=e.ptr.get(t);if(a)return a.done()},refresh:function(t){var a=e.ptr.get(t);if(a)return a.refresh()}})},static:{PullToRefresh:PullToRefresh},on:{tabMounted:function(e){var t=this;$(e).find(".ptr-content").each(function(e,a){t.ptr.create(a)})},tabBeforeRemove:function(e){var t=$(e),a=this;t.find(".ptr-content").each(function(e,t){a.ptr.destroy(t)})},pageInit:function(e){var t=this;e.$el.find(".ptr-content").each(function(e,a){t.ptr.create(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".ptr-content").each(function(e,a){t.ptr.destroy(a)})}}},Lazy={destroy:function(e){var t=$(e).closest(".page");t.length&&t[0].f7LazyDestroy&&t[0].f7LazyDestroy()},create:function(e){var t=this,a=$(e).closest(".page").eq(0),r=a.find(".lazy");if(0!==r.length||a.hasClass("lazy")){var n=t.params.lazy.placeholder;!1!==n&&r.each(function(e,t){$(t).attr("data-src")&&!$(t).attr("src")&&$(t).attr("src",n)});var i=[],s=!1;if(t.params.lazy.observer&&Support.intersectionObserver){var o=a[0].f7LazyObserver;return o||(o=new win.IntersectionObserver(function(e,a){e.forEach(function(e){if(e.isIntersecting){if(t.params.lazy.sequential&&s)return void(i.indexOf(e.target)<0&&i.push(e.target));s=!0,t.lazy.loadImage(e.target,l),a.unobserve(e.target)}})},{root:a[0]})),r.each(function(e,t){t.f7LazyObserverAdded||(t.f7LazyObserverAdded=!0,o.observe(t))}),void(a[0].f7LazyDestroy||(a[0].f7LazyDestroy=function(){o.disconnect(),delete a[0].f7LazyDestroy,delete a[0].f7LazyObserver}))}a[0].f7LazyDestroy||(a[0].f7LazyDestroy=function(){a[0].f7LazyAttached=!1,delete a[0].f7LazyAttached,a.off("lazy",p),a.off("scroll",p,!0),a.find(".tab").off("tab:mounted tab:show",p),t.off("resize",p)}),a[0].f7LazyAttached||(a[0].f7LazyAttached=!0,a.on("lazy",p),a.on("scroll",p,!0),a.find(".tab").on("tab:mounted tab:show",p),t.on("resize",p)),p()}function l(e){i.indexOf(e)>=0&&i.splice(i.indexOf(e),1),s=!1,t.params.lazy.sequential&&i.length>0&&(s=!0,t.lazy.loadImage(i[0],l))}function p(){t.lazy.load(a,function(e){t.params.lazy.sequential&&s?i.indexOf(e)<0&&i.push(e):(s=!0,t.lazy.loadImage(e,l))})}},isInViewport:function(e){var t=e.getBoundingClientRect(),a=this.params.lazy.threshold||0;return t.top>=0-a&&t.left>=0-a&&t.top<=this.height+a&&t.left<=this.width+a},loadImage:function(e,t){var a=this,r=$(e),n=r.attr("data-background"),i=n||r.attr("data-src");if(i){var s=new win.Image;s.onload=function(){r.removeClass("lazy").addClass("lazy-loaded"),n?r.css("background-image","url("+i+")"):r.attr("src",i),t&&t(e),r.trigger("lazy:loaded"),a.emit("lazyLoaded",r[0])},s.onerror=function(){r.removeClass("lazy").addClass("lazy-loaded"),n?r.css("background-image","url("+(a.params.lazy.placeholder||"")+")"):r.attr("src",a.params.lazy.placeholder||""),t&&t(e),r.trigger("lazy:error"),a.emit("lazyError",r[0])},s.src=i,r.removeAttr("data-src").removeAttr("data-background"),r.trigger("lazy:load"),a.emit("lazyLoad",r[0])}},load:function(e,t){var a=this,r=$(e);r.hasClass("page")||(r=r.parents(".page").eq(0)),0!==r.length&&r.find(".lazy").each(function(e,r){$(r).parents(".tab:not(.tab-active)").length>0||a.lazy.isInViewport(r)&&(t?t(r):a.lazy.loadImage(r))})}},Lazy$1={name:"lazy",params:{lazy:{placeholder:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEXCwsK592mkAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",threshold:0,sequential:!0,observer:!0}},create:function(){Utils.extend(this,{lazy:{create:Lazy.create.bind(this),destroy:Lazy.destroy.bind(this),loadImage:Lazy.loadImage.bind(this),load:Lazy.load.bind(this),isInViewport:Lazy.isInViewport.bind(this)}})},on:{pageInit:function(e){(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.create(e.$el)},pageAfterIn:function(e){this.params.lazy.observer&&Support.intersectionObserver||(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.create(e.$el)},pageBeforeRemove:function(e){(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.destroy(e.$el)},tabMounted:function(e){var t=$(e);(t.find(".lazy").length>0||t.hasClass("lazy"))&&this.lazy.create(t)},tabBeforeRemove:function(e){if(!this.params.lazy.observer||!Support.intersectionObserver){var t=$(e);(t.find(".lazy").length>0||t.hasClass("lazy"))&&this.lazy.destroy(t)}}}},DataTable=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n={};r.useModulesParams(n),r.params=Utils.extend(n,a);var i=$(r.params.el);if(0!==i.length){if(r.$el=i,r.el=i[0],r.$el[0].f7DataTable){var s=r.$el[0].f7DataTable;return r.destroy(),s}return r.$el[0].f7DataTable=r,Utils.extend(r,{collapsible:i.hasClass("data-table-collapsible"),$headerEl:i.find(".data-table-header"),$headerSelectedEl:i.find(".data-table-header-selected")}),r.attachEvents=function(){r.$el.on("change",'.checkbox-cell input[type="checkbox"]',o),r.$el.find("thead .sortable-cell").on("click",l)},r.detachEvents=function(){r.$el.off("change",'.checkbox-cell input[type="checkbox"]',o),r.$el.find("thead .sortable-cell").off("click",l)},r.useModules(),r.init(),r}function o(e){if(!e.detail||!e.detail.sentByF7DataTable){var t=$(this),a=t[0].checked,n=t.parents("td,th").index();t.parents("thead").length>0?(0===n&&i.find("tbody tr")[a?"addClass":"removeClass"]("data-table-row-selected"),i.find("tbody tr td:nth-child("+(n+1)+") input").prop("checked",a).trigger("change",{sentByF7DataTable:!0})):(0===n&&t.parents("tr")[a?"addClass":"removeClass"]("data-table-row-selected"),a?i.find("tbody .checkbox-cell:nth-child("+(n+1)+') input[type="checkbox"]:checked').length===i.find("tbody tr").length&&i.find("thead .checkbox-cell:nth-child("+(n+1)+') input[type="checkbox"]').prop("checked",!0).trigger("change",{sentByF7DataTable:!0}):i.find("thead .checkbox-cell:nth-child("+(n+1)+') input[type="checkbox"]').prop("checked",!1)),r.checkSelectedHeader()}}function l(){var e,t=$(this),a=t.hasClass("sortable-cell-active"),n=t.hasClass("sortable-desc")?"desc":"asc";a?(e="desc"===n?"asc":"desc",t.removeClass("sortable-desc sortable-asc").addClass("sortable-"+e)):(i.find("thead .sortable-cell-active").removeClass("sortable-cell-active"),t.addClass("sortable-cell-active"),e=n),t.trigger("datatable:sort",e),r.emit("local::sort dataTableSort",r,e)}}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setCollapsibleLabels=function(){var e=this;e.collapsible&&e.$el.find("tbody td:not(.checkbox-cell)").each(function(t,a){var r=$(a),n=r.index(),i=r.attr("data-collapsible-title");i||""===i||r.attr("data-collapsible-title",e.$el.find("thead th").eq(n).text())})},t.prototype.checkSelectedHeader=function(){if(this.$headerEl.length>0&&this.$headerSelectedEl.length>0){var e=this.$el.find("tbody .checkbox-cell input:checked").length;this.$el[e>0?"addClass":"removeClass"]("data-table-has-checked"),this.$headerSelectedEl.find(".data-table-selected-count").text(e)}},t.prototype.init=function(){this.attachEvents(),this.setCollapsibleLabels(),this.checkSelectedHeader()},t.prototype.destroy=function(){var e=this;e.$el.trigger("datatable:beforedestroy",e),e.emit("local::beforeDestroy dataTableBeforeDestroy",e),e.attachEvents(),e.$el[0]&&(e.$el[0].f7DataTable=null,delete e.$el[0].f7DataTable),Utils.deleteProps(e),e=null},t}(Framework7Class),DataTable$1={name:"dataTable",static:{DataTable:DataTable},create:function(){this.dataTable=ConstructorMethods({defaultSelector:".data-table",constructor:DataTable,app:this,domProp:"f7DataTable"})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".data-table-init").each(function(e,a){t.dataTable.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".data-table-init").each(function(e,a){t.dataTable.create({el:a})})},pageBeforeRemove:function(e){var t=this;e.$el.find(".data-table-init").each(function(e,a){t.dataTable.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".data-table-init").each(function(e,a){t.dataTable.create({el:a})})}},vnode:{"data-table-init":{insert:function(e){var t=e.elm;this.dataTable.create({el:t})},destroy:function(e){var t=e.elm;this.dataTable.destroy(t)}}}},Fab={morphOpen:function(e,t){var a=this,r=$(e),n=$(t);if(0!==n.length){n.transition(0).addClass("fab-morph-target-visible");var i={width:n[0].offsetWidth,height:n[0].offsetHeight,offset:n.offset(),borderRadius:n.css("border-radius"),zIndex:n.css("z-index")},s={width:r[0].offsetWidth,height:r[0].offsetHeight,offset:r.offset(),translateX:Utils.getTranslate(r[0],"x"),translateY:Utils.getTranslate(r[0],"y")};r[0].f7FabMorphData={$targetEl:n,target:i,fab:s};var o=s.offset.left+s.width/2-(i.offset.left+i.width/2)-s.translateX,l=s.offset.top+s.height/2-(i.offset.top+i.height/2)-s.translateY,p=i.width/s.width,c=i.height/s.height,d=Math.ceil(parseInt(i.borderRadius,10)/Math.max(p,c));d>0&&(d+=2),r[0].f7FabMorphResizeHandler=function(){r.transition(0).transform(""),n.transition(0),i.width=n[0].offsetWidth,i.height=n[0].offsetHeight,i.offset=n.offset(),s.offset=r.offset();var e=s.offset.left+s.width/2-(i.offset.left+i.width/2)-s.translateX,t=s.offset.top+s.height/2-(i.offset.top+i.height/2)-s.translateY,a=i.width/s.width,o=i.height/s.height;r.transform("translate3d("+-e+"px, "+-t+"px, 0) scale("+a+", "+o+")")},n.css("opacity",0).transform("scale("+1/p+", "+1/c+")"),r.addClass("fab-opened").css("z-index",i.zIndex-1).transform("translate3d("+-o+"px, "+-l+"px, 0)"),r.transitionEnd(function(){n.transition(""),Utils.nextFrame(function(){n.css("opacity",1).transform("scale(1,1)"),r.transform("translate3d("+-o+"px, "+-l+"px, 0) scale("+p+", "+c+")").css("border-radius",d+"px").css("box-shadow","none")}),a.on("resize",r[0].f7FabMorphResizeHandler),n.parents(".page-content").length>0&&n.parents(".page-content").on("scroll",r[0].f7FabMorphResizeHandler)})}},morphClose:function(e){var t=$(e),a=t[0].f7FabMorphData;if(a){var r=a.$targetEl,n=a.target,i=a.fab;if(0!==r.length){var s=i.offset.left+i.width/2-(n.offset.left+n.width/2)-i.translateX,o=i.offset.top+i.height/2-(n.offset.top+n.height/2)-i.translateY,l=n.width/i.width,p=n.height/i.height;this.off("resize",t[0].f7FabMorphResizeHandler),r.parents(".page-content").length>0&&r.parents(".page-content").off("scroll",t[0].f7FabMorphResizeHandler),r.css("opacity",0).transform("scale("+1/l+", "+1/p+")"),t.transition("").css("box-shadow","").css("border-radius","").transform("translate3d("+-s+"px, "+-o+"px, 0)"),t.transitionEnd(function(){t.css("z-index","").removeClass("fab-opened").transform(""),Utils.nextFrame(function(){t.transitionEnd(function(){r.removeClass("fab-morph-target-visible").css("opacity","").transform("").transition("")})})})}}},open:function(e,t){var a=$(e).eq(0),r=a.find(".fab-buttons");if(a.length&&!a.hasClass("fab-opened")&&(r.length||a.hasClass("fab-morph"))){if(this.fab.openedEl){if(this.fab.openedEl===a[0])return;this.fab.close(this.fab.openedEl)}this.fab.openedEl=a[0],a.hasClass("fab-morph")?this.fab.morphOpen(a,t||a.attr("data-morph-to")):a.addClass("fab-opened"),a.trigger("fab:open")}},close:function(e){void 0===e&&(e=".fab-opened");var t=$(e).eq(0),a=t.find(".fab-buttons");t.length&&t.hasClass("fab-opened")&&(a.length||t.hasClass("fab-morph"))&&(this.fab.openedEl=null,t.hasClass("fab-morph")?this.fab.morphClose(t):t.removeClass("fab-opened"),t.trigger("fab:close"))},toggle:function(e){$(e).hasClass("fab-opened")?this.fab.close(e):this.fab.open(e)}},Fab$1={name:"fab",create:function(){Utils.extend(this,{fab:{openedEl:null,morphOpen:Fab.morphOpen.bind(this),morphClose:Fab.morphClose.bind(this),open:Fab.open.bind(this),close:Fab.close.bind(this),toggle:Fab.toggle.bind(this)}})},clicks:{".fab > a":function(e){this.fab.toggle(e.parents(".fab"))},".fab-open":function(e,t){void 0===t&&(t={});this.fab.open(t.fab)},".fab-close":function(e,t){void 0===t&&(t={});this.fab.close(t.fab)}}},Searchbar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n={el:void 0,inputEl:void 0,inputEvents:"change input compositionend",disableButton:!0,disableButtonEl:void 0,backdropEl:void 0,searchContainer:void 0,searchItem:"li",searchIn:void 0,searchGroup:".list-group",searchGroupTitle:".item-divider, .list-group-title",ignore:".searchbar-ignore",foundEl:".searchbar-found",notFoundEl:".searchbar-not-found",hideOnEnableEl:".searchbar-hide-on-enable",hideOnSearchEl:".searchbar-hide-on-search",backdrop:void 0,removeDiacritics:!0,customSearch:!1,hideDividers:!0,hideGroups:!0,disableOnBackdropClick:!0,expandable:!1,inline:!1};r.useModulesParams(n),r.params=Utils.extend(n,a);var i,s=$(r.params.el);if(0===s.length)return r;if(s[0].f7Searchbar)return s[0].f7Searchbar;s[0].f7Searchbar=r;var o,l,p,c,d=s.parents(".navbar-inner");if(s.parents(".page").length>0)i=s.parents(".page");else if(d.length>0&&!(i=$(t.navbar.getPageByEl(d[0]))).length){var u=s.parents(".view").find(".page-current");u[0]&&u[0].f7Page&&u[0].f7Page.navbarEl===d[0]&&(i=u)}a.foundEl?o=$(a.foundEl):"string"==typeof r.params.foundEl&&i&&(o=i.find(r.params.foundEl)),a.notFoundEl?l=$(a.notFoundEl):"string"==typeof r.params.notFoundEl&&i&&(l=i.find(r.params.notFoundEl)),a.hideOnEnableEl?p=$(a.hideOnEnableEl):"string"==typeof r.params.hideOnEnableEl&&i&&(p=i.find(r.params.hideOnEnableEl)),a.hideOnSearchEl?c=$(a.hideOnSearchEl):"string"==typeof r.params.hideOnSearchEl&&i&&(c=i.find(r.params.hideOnSearchEl));var h,f,v,m,g=r.params.expandable||s.hasClass("searchbar-expandable"),b=r.params.inline||s.hasClass("searchbar-inline");function y(e){e.preventDefault()}function w(e){r.enable(e),r.$el.addClass("searchbar-focused")}function C(){r.$el.removeClass("searchbar-focused"),"aurora"!==t.theme||m&&m.length&&r.params.disableButton||r.query||r.disable()}function x(){var e=r.$inputEl.val().trim();(r.$searchContainer&&r.$searchContainer.length>0&&(r.params.searchIn||r.isVirtualList||r.params.searchIn===r.params.searchItem)||r.params.customSearch)&&r.search(e,!0)}function E(e,t){r.$el.trigger("searchbar:clear",t),r.emit("local::clear searchbarClear",r,t)}function k(e){r.disable(e)}function S(){!r||r&&!r.$el||r.enabled&&(r.$el.removeClass("searchbar-enabled"),r.expandable&&r.$el.parents(".navbar-inner").removeClass("with-searchbar-expandable-enabled"))}function T(){!r||r&&!r.$el||r.enabled&&(r.$el.addClass("searchbar-enabled"),r.expandable&&r.$el.parents(".navbar-inner").addClass("with-searchbar-expandable-enabled"))}return void 0===r.params.backdrop&&(r.params.backdrop=!b&&"aurora"!==t.theme),r.params.backdrop&&0===(h=r.params.backdropEl?$(r.params.backdropEl):i&&i.length>0?i.find(".searchbar-backdrop"):s.siblings(".searchbar-backdrop")).length&&(h=$('<div class="searchbar-backdrop"></div>'),i&&i.length?s.parents(i).length>0&&d&&0===s.parents(d).length?h.insertBefore(s):h.insertBefore(i.find(".page-content").eq(0)):h.insertBefore(s)),r.params.searchContainer&&(f=$(r.params.searchContainer)),v=r.params.inputEl?$(r.params.inputEl):s.find('input[type="search"]').eq(0),r.params.disableButton&&(m=r.params.disableButtonEl?$(r.params.disableButtonEl):s.find(".searchbar-disable-button")),Utils.extend(r,{app:t,view:t.views.get(s.parents(".view")),$el:s,el:s[0],$backdropEl:h,backdropEl:h&&h[0],$searchContainer:f,searchContainer:f&&f[0],$inputEl:v,inputEl:v[0],$disableButtonEl:m,disableButtonEl:m&&m[0],disableButtonHasMargin:!1,$pageEl:i,pageEl:i&&i[0],$navbarEl:d,navbarEl:d&&d[0],$foundEl:o,foundEl:o&&o[0],$notFoundEl:l,notFoundEl:l&&l[0],$hideOnEnableEl:p,hideOnEnableEl:p&&p[0],$hideOnSearchEl:c,hideOnSearchEl:c&&c[0],previousQuery:"",query:"",isVirtualList:f&&f.hasClass("virtual-list"),virtualList:void 0,enabled:!1,expandable:g,inline:b}),r.attachEvents=function(){s.on("submit",y),r.params.disableButton&&r.$disableButtonEl.on("click",k),r.params.disableOnBackdropClick&&r.$backdropEl&&r.$backdropEl.on("click",k),r.expandable&&"ios"===t.theme&&r.view&&d.length&&r.$pageEl&&(r.$pageEl.on("page:beforeout",S),r.$pageEl.on("page:beforein",T)),r.$inputEl.on("focus",w),r.$inputEl.on("blur",C),r.$inputEl.on(r.params.inputEvents,x),r.$inputEl.on("input:clear",E)},r.detachEvents=function(){s.off("submit",y),r.params.disableButton&&r.$disableButtonEl.off("click",k),r.params.disableOnBackdropClick&&r.$backdropEl&&r.$backdropEl.off("click",k),r.expandable&&"ios"===t.theme&&r.view&&d.length&&r.$pageEl&&(r.$pageEl.off("page:beforeout",S),r.$pageEl.off("page:beforein",T)),r.$inputEl.off("focus",w),r.$inputEl.off("blur",C),r.$inputEl.off(r.params.inputEvents,x),r.$inputEl.off("input:clear",E)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.clear=function(e){var t=this;if(!t.query&&e&&$(e.target).hasClass("searchbar-clear"))return t.disable(),t;var a=t.value;return t.$inputEl.val("").trigger("change").focus(),t.$el.trigger("searchbar:clear",a),t.emit("local::clear searchbarClear",t,a),t},t.prototype.setDisableButtonMargin=function(){var e=this;if(!e.expandable){var t=e.app;e.$disableButtonEl.transition(0).show(),e.$disableButtonEl.css("margin-"+(t.rtl?"left":"right"),-e.disableButtonEl.offsetWidth+"px"),e._clientLeft=e.$disableButtonEl[0].clientLeft,e.$disableButtonEl.transition(""),e.disableButtonHasMargin=!0}},t.prototype.enable=function(e){var t=this;if(t.enabled)return t;var a=t.app;function r(){t.$backdropEl&&(t.$searchContainer&&t.$searchContainer.length||t.params.customSearch)&&!t.$el.hasClass("searchbar-enabled")&&!t.query&&t.backdropShow(),t.$el.addClass("searchbar-enabled"),(!t.$disableButtonEl||t.$disableButtonEl&&0===t.$disableButtonEl.length)&&t.$el.addClass("searchbar-enabled-no-disable-button"),!t.expandable&&t.$disableButtonEl&&t.$disableButtonEl.length>0&&"md"!==a.theme&&(t.disableButtonHasMargin||t.setDisableButtonMargin(),t.$disableButtonEl.css("margin-"+(a.rtl?"left":"right"),"0px")),t.expandable&&(t.$el.parents(".navbar-inner").hasClass("navbar-inner-large")&&t.$pageEl&&t.$pageEl.find(".page-content").addClass("with-searchbar-expandable-enabled"),"md"===a.theme&&t.$el.parent(".navbar-inner").parent(".navbar").length?t.$el.parent(".navbar-inner").parent(".navbar").addClass("with-searchbar-expandable-enabled"):(t.$el.parent(".navbar-inner").addClass("with-searchbar-expandable-enabled"),t.$el.parent(".navbar-inner-large").addClass("navbar-inner-large-collapsed"))),t.$hideOnEnableEl&&t.$hideOnEnableEl.addClass("hidden-by-searchbar"),t.$el.trigger("searchbar:enable"),t.emit("local::enable searchbarEnable",t)}t.enabled=!0;var n=!1;return!0===e&&doc.activeElement!==t.inputEl&&(n=!0),a.device.ios&&"ios"===a.theme?t.expandable?(n&&t.$inputEl.focus(),r()):(n&&t.$inputEl.focus(),!e||"focus"!==e.type&&!0!==e?r():Utils.nextTick(function(){r()},400)):(n&&t.$inputEl.focus(),"md"===a.theme&&t.expandable&&t.$el.parents(".page, .view, .navbar-inner").scrollLeft(0),r()),t},t.prototype.disable=function(){var e=this;if(!e.enabled)return e;var t=e.app;return e.$inputEl.val("").trigger("change"),e.$el.removeClass("searchbar-enabled searchbar-focused searchbar-enabled-no-disable-button"),e.expandable&&(e.$el.parents(".navbar-inner").hasClass("navbar-inner-large")&&e.$pageEl&&e.$pageEl.find(".page-content").removeClass("with-searchbar-expandable-enabled"),"md"===t.theme&&e.$el.parent(".navbar-inner").parent(".navbar").length?e.$el.parent(".navbar-inner").parent(".navbar").removeClass("with-searchbar-expandable-enabled"):(e.$el.parent(".navbar-inner").removeClass("with-searchbar-expandable-enabled"),e.$pageEl&&e.$pageEl.find(".page-content").trigger("scroll"))),!e.expandable&&e.$disableButtonEl&&e.$disableButtonEl.length>0&&"md"!==t.theme&&e.$disableButtonEl.css("margin-"+(t.rtl?"left":"right"),-e.disableButtonEl.offsetWidth+"px"),e.$backdropEl&&(e.$searchContainer&&e.$searchContainer.length||e.params.customSearch)&&e.backdropHide(),e.enabled=!1,e.$inputEl.blur(),e.$hideOnEnableEl&&e.$hideOnEnableEl.removeClass("hidden-by-searchbar"),e.$el.trigger("searchbar:disable"),e.emit("local::disable searchbarDisable",e),e},t.prototype.toggle=function(){return this.enabled?this.disable():this.enable(!0),this},t.prototype.backdropShow=function(){return this.$backdropEl&&this.$backdropEl.addClass("searchbar-backdrop-in"),this},t.prototype.backdropHide=function(){return this.$backdropEl&&this.$backdropEl.removeClass("searchbar-backdrop-in"),this},t.prototype.search=function(e,t){var a=this;if(a.previousQuery=a.query||"",e===a.previousQuery)return a;t||(a.enabled||a.enable(),a.$inputEl.val(e),a.$inputEl.trigger("input")),a.query=e,a.value=e;var r=a.$searchContainer,n=a.$el,i=a.$foundEl,s=a.$notFoundEl,o=a.$hideOnSearchEl,l=a.isVirtualList;if(e.length>0&&o?o.addClass("hidden-by-searchbar"):o&&o.removeClass("hidden-by-searchbar"),(r&&r.length&&n.hasClass("searchbar-enabled")||a.params.customSearch&&n.hasClass("searchbar-enabled"))&&(0===e.length?a.backdropShow():a.backdropHide()),a.params.customSearch)return n.trigger("searchbar:search",e,a.previousQuery),a.emit("local::search searchbarSearch",a,e,a.previousQuery),a;var p,c=[];if(l){if(a.virtualList=r[0].f7VirtualList,""===e.trim())return a.virtualList.resetFilter(),s&&s.hide(),i&&i.show(),n.trigger("searchbar:search",e,a.previousQuery),a.emit("local::search searchbarSearch",a,e,a.previousQuery),a;if(p=a.params.removeDiacritics?Utils.removeDiacritics(e):e,a.virtualList.params.searchAll)c=a.virtualList.params.searchAll(p,a.virtualList.items)||[];else if(a.virtualList.params.searchByItem)for(var d=0;d<a.virtualList.items.length;d+=1)a.virtualList.params.searchByItem(p,a.virtualList.params.items[d],d)&&c.push(d)}else{var u;u=a.params.removeDiacritics?Utils.removeDiacritics(e.trim().toLowerCase()).split(" "):e.trim().toLowerCase().split(" "),r.find(a.params.searchItem).removeClass("hidden-by-searchbar").each(function(e,t){var r=$(t),n=[],i=a.params.searchIn?r.find(a.params.searchIn):r;a.params.searchIn===a.params.searchItem&&(i=r),i.each(function(e,t){var r=$(t).text().trim().toLowerCase();a.params.removeDiacritics&&(r=Utils.removeDiacritics(r)),n.push(r)}),n=n.join(" ");for(var s=0,o=0;o<u.length;o+=1)n.indexOf(u[o])>=0&&(s+=1);s===u.length||a.params.ignore&&r.is(a.params.ignore)?c.push(r[0]):r.addClass("hidden-by-searchbar")}),a.params.hideDividers&&r.find(a.params.searchGroupTitle).each(function(e,t){for(var r=$(t),n=r.nextAll(a.params.searchItem),i=!0,s=0;s<n.length;s+=1){var o=n.eq(s);if(o.is(a.params.searchGroupTitle))break;o.hasClass("hidden-by-searchbar")||(i=!1)}var l=a.params.ignore&&r.is(a.params.ignore);i&&!l?r.addClass("hidden-by-searchbar"):r.removeClass("hidden-by-searchbar")}),a.params.hideGroups&&r.find(a.params.searchGroup).each(function(e,t){var r=$(t),n=a.params.ignore&&r.is(a.params.ignore);0!==r.find(a.params.searchItem).filter(function(e,t){return!$(t).hasClass("hidden-by-searchbar")}).length||n?r.removeClass("hidden-by-searchbar"):r.addClass("hidden-by-searchbar")})}return 0===c.length?(s&&s.show(),i&&i.hide()):(s&&s.hide(),i&&i.show()),l&&a.virtualList&&a.virtualList.filterItems(c),n.trigger("searchbar:search",e,a.previousQuery,c),a.emit("local::search searchbarSearch",a,e,a.previousQuery,c),a},t.prototype.init=function(){var e=this;e.expandable&&e.$el&&e.$el.addClass("searchbar-expandable"),e.inline&&e.$el&&e.$el.addClass("searchbar-inline"),e.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy searchbarBeforeDestroy",e),e.$el.trigger("searchbar:beforedestroy",e),e.detachEvents(),e.$el[0]&&(e.$el[0].f7Searchbar=null,delete e.$el[0].f7Searchbar),Utils.deleteProps(e)},t}(Framework7Class),Searchbar$1={name:"searchbar",static:{Searchbar:Searchbar},create:function(){this.searchbar=ConstructorMethods({defaultSelector:".searchbar",constructor:Searchbar,app:this,domProp:"f7Searchbar",addMethods:"clear enable disable toggle search".split(" ")})},on:{tabMounted:function(e){var t=this;$(e).find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))})},tabBeforeRemove:function(e){$(e).find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()})},pageInit:function(e){var t=this;e.$el.find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))}),"ios"===t.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))})},pageBeforeRemove:function(e){e.$el.find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()}),"ios"===this.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()})}},clicks:{".searchbar-clear":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.clear()},".searchbar-enable":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.enable(!0)},".searchbar-disable":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.disable()},".searchbar-toggle":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.toggle()}},vnode:{"searchbar-init":{insert:function(e){var t=e.elm,a=$(t);this.searchbar.create(Utils.extend(a.dataset(),{el:t}))},destroy:function(e){var t=e.elm;t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()}}}},Messages=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n={autoLayout:!0,messages:[],newMessagesFirst:!1,scrollMessages:!0,scrollMessagesOnEdge:!0,firstMessageRule:void 0,lastMessageRule:void 0,tailMessageRule:void 0,sameNameMessageRule:void 0,sameHeaderMessageRule:void 0,sameFooterMessageRule:void 0,sameAvatarMessageRule:void 0,customClassMessageRule:void 0,renderMessage:void 0};r.useModulesParams(n),r.params=Utils.extend(n,a);var i=$(a.el).eq(0);if(0===i.length)return r;if(i[0].f7Messages)return i[0].f7Messages;i[0].f7Messages=r;var s=i.closest(".page-content").eq(0);return Utils.extend(r,{messages:r.params.messages,$el:i,el:i[0],$pageContentEl:s,pageContentEl:s[0]}),r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.getMessageData=function(e){var t=$(e),a={name:t.find(".message-name").html(),header:t.find(".message-header").html(),textHeader:t.find(".message-text-header").html(),textFooter:t.find(".message-text-footer").html(),footer:t.find(".message-footer").html(),isTitle:t.hasClass("messages-title"),type:t.hasClass("message-sent")?"sent":"received",text:t.find(".message-text").html(),image:t.find(".message-image").html(),imageSrc:t.find(".message-image img").attr("src"),typing:t.hasClass("message-typing")};a.isTitle&&(a.text=t.html()),a.text&&a.textHeader&&(a.text=a.text.replace('<div class="message-text-header">'+a.textHeader+"</div>","")),a.text&&a.textFooter&&(a.text=a.text.replace('<div class="message-text-footer">'+a.textFooter+"</div>",""));var r=t.find(".message-avatar").css("background-image");return"none"!==r&&""!==r||(r=void 0),r=r&&"string"==typeof r?r.replace("url(","").replace(")","").replace(/"/g,"").replace(/'/g,""):void 0,a.avatar=r,a},t.prototype.getMessagesData=function(){var e=this,t=[];return e.$el.find(".message, .messages-title").each(function(a,r){t.push(e.getMessageData(r))}),t},t.prototype.renderMessage=function(e){var t=this,a=Utils.extend({type:"sent",attrs:{}},e);if(t.params.renderMessage)return t.params.renderMessage.call(t,a);if(a.isTitle)return'<div class="messages-title">'+a.text+"</div>";var r=Object.keys(a.attrs).map(function(e){return e+'="'+a.attrs[e]+'"'}).join(" ");return'\n      <div class="message message-'+a.type+" "+(a.isTyping?"message-typing":"")+" "+(a.cssClass||"")+'" '+r+">\n        "+(a.avatar?'\n        <div class="message-avatar" style="background-image:url('+a.avatar+')"></div>\n        ':"")+'\n        <div class="message-content">\n          '+(a.name?'<div class="message-name">'+a.name+"</div>":"")+"\n          "+(a.header?'<div class="message-header">'+a.header+"</div>":"")+'\n          <div class="message-bubble">\n            '+(a.textHeader?'<div class="message-text-header">'+a.textHeader+"</div>":"")+"\n            "+(a.image?'<div class="message-image">'+a.image+"</div>":"")+"\n            "+(a.imageSrc&&!a.image?'<div class="message-image"><img src="'+a.imageSrc+'"></div>':"")+"\n            "+(a.text||a.isTyping?'<div class="message-text">'+(a.text||"")+(a.isTyping?'<div class="message-typing-indicator"><div></div><div></div><div></div></div>':"")+"</div>":"")+"\n            "+(a.textFooter?'<div class="message-text-footer">'+a.textFooter+"</div>":"")+"\n          </div>\n          "+(a.footer?'<div class="message-footer">'+a.footer+"</div>":"")+"\n        </div>\n      </div>\n    "},t.prototype.renderMessages=function(e,t){void 0===e&&(e=this.messages),void 0===t&&(t=this.params.newMessagesFirst?"prepend":"append");var a=this,r=e.map(function(e){return a.renderMessage(e)}).join("");a.$el[t](r)},t.prototype.isFirstMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.firstMessageRule&&(e=this.params).firstMessageRule.apply(e,t)},t.prototype.isLastMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.lastMessageRule&&(e=this.params).lastMessageRule.apply(e,t)},t.prototype.isTailMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.tailMessageRule&&(e=this.params).tailMessageRule.apply(e,t)},t.prototype.isSameNameMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameNameMessageRule&&(e=this.params).sameNameMessageRule.apply(e,t)},t.prototype.isSameHeaderMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameHeaderMessageRule&&(e=this.params).sameHeaderMessageRule.apply(e,t)},t.prototype.isSameFooterMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameFooterMessageRule&&(e=this.params).sameFooterMessageRule.apply(e,t)},t.prototype.isSameAvatarMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameAvatarMessageRule&&(e=this.params).sameAvatarMessageRule.apply(e,t)},t.prototype.isCustomClassMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];if(this.params.customClassMessageRule)return(e=this.params).customClassMessageRule.apply(e,t)},t.prototype.layout=function(){var e=this;e.$el.find(".message, .messages-title").each(function(t,a){var r=$(a);e.messages||(e.messages=e.getMessagesData());var n=[],i=e.messages[t],s=e.messages[t-1],o=e.messages[t+1];e.isFirstMessage(i,s,o)&&n.push("message-first"),e.isLastMessage(i,s,o)&&n.push("message-last"),e.isTailMessage(i,s,o)&&n.push("message-tail"),e.isSameNameMessage(i,s,o)&&n.push("message-same-name"),e.isSameHeaderMessage(i,s,o)&&n.push("message-same-header"),e.isSameFooterMessage(i,s,o)&&n.push("message-same-footer"),e.isSameAvatarMessage(i,s,o)&&n.push("message-same-avatar");var l=e.isCustomClassMessage(i,s,o);l&&l.length&&("string"==typeof l&&(l=l.split(" ")),l.forEach(function(e){n.push(e)})),r.removeClass("message-first message-last message-tail message-same-name message-same-header message-same-footer message-same-avatar"),n.forEach(function(e){r.addClass(e)})})},t.prototype.clear=function(){this.messages=[],this.$el.html("")},t.prototype.removeMessage=function(e,t){void 0===t&&(t=!0);var a,r,n=this;return"number"==typeof e?(a=e,r=n.$el.find(".message, .messages-title").eq(a)):n.messages&&n.messages.indexOf(e)>=0?(a=n.messages.indexOf(e),r=n.$el.children().eq(a)):a=(r=$(e)).index(),0===r.length?n:(r.remove(),n.messages.splice(a,1),n.params.autoLayout&&t&&n.layout(),n)},t.prototype.removeMessages=function(e,t){void 0===t&&(t=!0);var a=this;if(Array.isArray(e)){var r=[];e.forEach(function(e){r.push(a.$el.find(".message, .messages-title").eq(e))}),r.forEach(function(e){a.removeMessage(e,!1)})}else $(e).each(function(e,t){a.removeMessage(t,!1)});return a.params.autoLayout&&t&&a.layout(),a},t.prototype.addMessage=function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var n,i,s;return"boolean"==typeof a[1]?(n=(e=a)[0],i=e[1],s=e[2]):(n=(t=a)[0],s=t[1],i=t[2]),void 0===i&&(i=!0),void 0===s&&(s=this.params.newMessagesFirst?"prepend":"append"),this.addMessages([n],i,s)},t.prototype.addMessages=function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var n,i,s,o=this;"boolean"==typeof a[1]?(n=(e=a)[0],i=e[1],s=e[2]):(n=(t=a)[0],s=t[1],i=t[2]),void 0===i&&(i=!0),void 0===s&&(s=o.params.newMessagesFirst?"prepend":"append");var l=o.pageContentEl.scrollHeight,p=o.pageContentEl.offsetHeight,c=o.pageContentEl.scrollTop,d="",u=o.messages.filter(function(e){return e.isTyping})[0];n.forEach(function(e){u?"append"===s?o.messages.splice(o.messages.indexOf(u),0,e):o.messages.splice(o.messages.indexOf(u)+1,0,e):o.messages["append"===s?"push":"unshift"](e),d+=o.renderMessage(e)});var h=$(d);if(i&&("append"!==s||o.params.newMessagesFirst||h.addClass("message-appear-from-bottom"),"prepend"===s&&o.params.newMessagesFirst&&h.addClass("message-appear-from-top")),u?"append"===s?h.insertBefore(o.$el.find(".message-typing")):h.insertAfter(o.$el.find(".message-typing")):o.$el[s](h),o.params.autoLayout&&o.layout(),"prepend"!==s||u||(o.pageContentEl.scrollTop=c+(o.pageContentEl.scrollHeight-l)),o.params.scrollMessages&&("append"===s&&!o.params.newMessagesFirst||"prepend"===s&&o.params.newMessagesFirst&&!u))if(o.params.scrollMessagesOnEdge){var f=!1;o.params.newMessagesFirst&&0===c&&(f=!0),!o.params.newMessagesFirst&&c-(l-p)>=-10&&(f=!0),f&&o.scroll(i?void 0:0)}else o.scroll(i?void 0:0);return o},t.prototype.showTyping=function(e){void 0===e&&(e={});var t=this,a=t.messages.filter(function(e){return e.isTyping})[0];return a&&t.removeMessage(t.messages.indexOf(a)),t.addMessage(Utils.extend({type:"received",isTyping:!0},e)),t},t.prototype.hideTyping=function(){var e,t,a=this;if(a.messages.forEach(function(t,a){t.isTyping&&(e=a)}),void 0!==e&&a.$el.find(".message").eq(e).hasClass("message-typing")&&(t=!0,a.removeMessage(e)),!t){var r=a.$el.find(".message-typing");r.length&&a.removeMessage(r)}return a},t.prototype.scroll=function(e,t){void 0===e&&(e=300);var a,r=this,n=r.pageContentEl.scrollTop;if(void 0!==t)a=t;else if((a=r.params.newMessagesFirst?0:r.pageContentEl.scrollHeight-r.pageContentEl.offsetHeight)===n)return r;return r.$pageContentEl.scrollTop(a,e),r},t.prototype.init=function(){var e=this;e.messages&&0!==e.messages.length||(e.messages=e.getMessagesData()),e.params.messages&&e.params.messages.length&&e.renderMessages(),e.params.autoLayout&&e.layout(),e.params.scrollMessages&&e.scroll(0)},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy messagesBeforeDestroy",e),e.$el.trigger("messages:beforedestroy",e),e.$el[0]&&(e.$el[0].f7Messages=null,delete e.$el[0].f7Messages),Utils.deleteProps(e)},t}(Framework7Class),Messages$1={name:"messages",static:{Messages:Messages},create:function(){this.messages=ConstructorMethods({defaultSelector:".messages",constructor:Messages,app:this,domProp:"f7Messages",addMethods:"renderMessages layout scroll clear removeMessage removeMessages addMessage addMessages".split(" ")})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".messages-init").each(function(e,a){t.messages.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".messages-init").each(function(e,a){t.messages.create({el:a})})},pageBeforeRemove:function(e){var t=this;e.$el.find(".messages-init").each(function(e,a){t.messages.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".messages-init").each(function(e,a){t.messages.create({el:a})})}},vnode:{"messages-init":{insert:function(e){var t=e.elm;this.messages.create({el:t})},destroy:function(e){var t=e.elm;this.messages.destroy(t)}}}},Messagebar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,n={top:!1,topOffset:0,bottomOffset:0,attachments:[],renderAttachments:void 0,renderAttachment:void 0,maxHeight:null,resizePage:!0};r.useModulesParams(n),r.params=Utils.extend(n,a);var i=$(r.params.el);if(0===i.length)return r;if(i[0].f7Messagebar)return i[0].f7Messagebar;i[0].f7Messagebar=r;var s,o=i.parents(".page").eq(0),l=o.find(".page-content").eq(0),p=i.find(".messagebar-area");s=r.params.textareaEl?$(r.params.textareaEl):i.find("textarea");var c=i.find(".messagebar-attachments"),d=i.find(".messagebar-sheet");function u(){r.params.resizePage&&r.resizePage()}function h(e){e.preventDefault()}function f(e){var t=$(this).index();$(e.target).closest(".messagebar-attachment-delete").length?($(this).trigger("messagebar:attachmentdelete",t),r.emit("local::attachmentDelete messagebarAttachmentDelete",r,this,t)):($(this).trigger("messagebar:attachmentclick",t),r.emit("local::attachmentClick messagebarAttachmentClick",r,this,t))}function v(){r.checkEmptyState(),r.$el.trigger("messagebar:change"),r.emit("local::change messagebarChange",r)}function m(){r.sheetHide(),r.$el.addClass("messagebar-focused"),r.$el.trigger("messagebar:focus"),r.emit("local::focus messagebarFocus",r)}function g(){r.$el.removeClass("messagebar-focused"),r.$el.trigger("messagebar:blur"),r.emit("local::blur messagebarBlur",r)}return r.params.top&&i.addClass("messagebar-top"),Utils.extend(r,{$el:i,el:i[0],$areaEl:p,areaEl:p[0],$textareaEl:s,textareaEl:s[0],$attachmentsEl:c,attachmentsEl:c[0],attachmentsVisible:c.hasClass("messagebar-attachments-visible"),$sheetEl:d,sheetEl:d[0],sheetVisible:d.hasClass("messagebar-sheet-visible"),$pageEl:o,pageEl:o[0],$pageContentEl:l,pageContentEl:l,top:i.hasClass("messagebar-top")||r.params.top,attachments:[]}),r.attachEvents=function(){i.on("textarea:resize",u),i.on("submit",h),i.on("click",".messagebar-attachment",f),s.on("change input",v),s.on("focus",m),s.on("blur",g),t.on("resize",u)},r.detachEvents=function(){i.off("textarea:resize",u),i.off("submit",h),i.off("click",".messagebar-attachment",f),s.off("change input",v),s.off("focus",m),s.off("blur",g),t.off("resize",u)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.focus=function(){return this.$textareaEl.focus(),this},t.prototype.blur=function(){return this.$textareaEl.blur(),this},t.prototype.clear=function(){return this.$textareaEl.val("").trigger("change"),this},t.prototype.getValue=function(){return this.$textareaEl.val().trim()},t.prototype.setValue=function(e){return this.$textareaEl.val(e).trigger("change"),this},t.prototype.setPlaceholder=function(e){return this.$textareaEl.attr("placeholder",e),this},t.prototype.resizePage=function(){var e=this.params,t=this.$el,a=this.top,r=this.$pageEl,n=this.$pageContentEl,i=this.$areaEl,s=this.$textareaEl,o=this.$sheetEl,l=this.$attachmentsEl,p=t[0].offsetHeight,c=e.maxHeight;if(a);else{var d=parseInt(n.css("padding-bottom"),10),u=p+e.bottomOffset;if(u!==d&&n.length){var h=parseInt(n.css("padding-top"),10),f=n[0].scrollHeight,v=n[0].offsetHeight,m=n[0].scrollTop===f-v;c||(c=r[0].offsetHeight-h-o.outerHeight()-l.outerHeight()-parseInt(i.css("margin-top"),10)-parseInt(i.css("margin-bottom"),10)),s.css("max-height",c+"px"),n.css("padding-bottom",u+"px"),m&&n.scrollTop(n[0].scrollHeight-v),t.trigger("messagebar:resizepage"),this.emit("local::resizePage messagebarResizePage",this)}}},t.prototype.checkEmptyState=function(){var e=this.$el,t=this.$textareaEl.val().trim();t&&t.length?e.addClass("messagebar-with-value"):e.removeClass("messagebar-with-value")},t.prototype.attachmentsCreate=function(e){void 0===e&&(e="");var t=$('<div class="messagebar-attachments">'+e+"</div>");return t.insertBefore(this.$textareaEl),Utils.extend(this,{$attachmentsEl:t,attachmentsEl:t[0]}),this},t.prototype.attachmentsShow=function(e){void 0===e&&(e="");return this.$attachmentsEl=this.$el.find(".messagebar-attachments"),0===this.$attachmentsEl.length&&this.attachmentsCreate(e),this.$el.addClass("messagebar-attachments-visible"),this.attachmentsVisible=!0,this.params.resizePage&&this.resizePage(),this},t.prototype.attachmentsHide=function(){return this.$el.removeClass("messagebar-attachments-visible"),this.attachmentsVisible=!1,this.params.resizePage&&this.resizePage(),this},t.prototype.attachmentsToggle=function(){return this.attachmentsVisible?this.attachmentsHide():this.attachmentsShow(),this},t.prototype.renderAttachment=function(e){return this.params.renderAttachment?this.params.renderAttachment.call(this,e):'\n      <div class="messagebar-attachment">\n        <img src="'+e+'">\n        <span class="messagebar-attachment-delete"></span>\n      </div>\n    '},t.prototype.renderAttachments=function(){var e,t=this;e=t.params.renderAttachments?t.params.renderAttachments.call(t,t.attachments):""+t.attachments.map(function(e){return t.renderAttachment(e)}).join(""),0===t.$attachmentsEl.length?t.attachmentsCreate(e):t.$attachmentsEl.html(e)},t.prototype.sheetCreate=function(e){void 0===e&&(e="");var t=$('<div class="messagebar-sheet">'+e+"</div>");return this.$el.append(t),Utils.extend(this,{$sheetEl:t,sheetEl:t[0]}),this},t.prototype.sheetShow=function(e){void 0===e&&(e="");return this.$sheetEl=this.$el.find(".messagebar-sheet"),0===this.$sheetEl.length&&this.sheetCreate(e),this.$el.addClass("messagebar-sheet-visible"),this.sheetVisible=!0,this.params.resizePage&&this.resizePage(),this},t.prototype.sheetHide=function(){return this.$el.removeClass("messagebar-sheet-visible"),this.sheetVisible=!1,this.params.resizePage&&this.resizePage(),this},t.prototype.sheetToggle=function(){return this.sheetVisible?this.sheetHide():this.sheetShow(),this},t.prototype.init=function(){return this.attachEvents(),this.checkEmptyState(),this},t.prototype.destroy=function(){this.emit("local::beforeDestroy messagebarBeforeDestroy",this),this.$el.trigger("messagebar:beforedestroy",this),this.detachEvents(),this.$el[0]&&(this.$el[0].f7Messagebar=null,delete this.$el[0].f7Messagebar),Utils.deleteProps(this)},t}(Framework7Class),Messagebar$1={name:"messagebar",static:{Messagebar:Messagebar},create:function(){this.messagebar=ConstructorMethods({defaultSelector:".messagebar",constructor:Messagebar,app:this,domProp:"f7Messagebar",addMethods:"clear getValue setValue setPlaceholder resizePage focus blur attachmentsCreate attachmentsShow attachmentsHide attachmentsToggle renderAttachments sheetCreate sheetShow sheetHide sheetToggle".split(" ")})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".messagebar-init").each(function(e,a){t.messagebar.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".messagebar-init").each(function(e,a){t.messagebar.create(Utils.extend({el:a},$(a).dataset()))})},pageBeforeRemove:function(e){var t=this;e.$el.find(".messagebar-init").each(function(e,a){t.messagebar.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".messagebar-init").each(function(e,a){t.messagebar.create(Utils.extend({el:a},$(a).dataset()))})}},vnode:{"messagebar-init":{insert:function(e){var t=e.elm;this.messagebar.create(Utils.extend({el:t},$(t).dataset()))},destroy:function(e){var t=e.elm;this.messagebar.destroy(t)}}}},Browser=function(){return{isIE:!!win.navigator.userAgent.match(/Trident/g)||!!win.navigator.userAgent.match(/MSIE/g),isSafari:(e=win.navigator.userAgent.toLowerCase(),e.indexOf("safari")>=0&&e.indexOf("chrome")<0&&e.indexOf("android")<0),isUiWebView:/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i.test(win.navigator.userAgent)};var e}();function updateSize(){var e,t,a=this.$el;e=void 0!==this.params.width?this.params.width:a[0].clientWidth,t=void 0!==this.params.height?this.params.height:a[0].clientHeight,0===e&&this.isHorizontal()||0===t&&this.isVertical()||(e=e-parseInt(a.css("padding-left"),10)-parseInt(a.css("padding-right"),10),t=t-parseInt(a.css("padding-top"),10)-parseInt(a.css("padding-bottom"),10),Utils.extend(this,{width:e,height:t,size:this.isHorizontal()?e:t}))}function updateSlides(){var e=this.params,t=this.$wrapperEl,a=this.size,r=this.rtlTranslate,n=this.wrongRTL,i=this.virtual&&e.virtual.enabled,s=i?this.virtual.slides.length:this.slides.length,o=t.children("."+this.params.slideClass),l=i?this.virtual.slides.length:o.length,p=[],c=[],d=[],u=e.slidesOffsetBefore;"function"==typeof u&&(u=e.slidesOffsetBefore.call(this));var h=e.slidesOffsetAfter;"function"==typeof h&&(h=e.slidesOffsetAfter.call(this));var f=this.snapGrid.length,v=this.snapGrid.length,m=e.spaceBetween,g=-u,b=0,y=0;if(void 0!==a){var w,C;"string"==typeof m&&m.indexOf("%")>=0&&(m=parseFloat(m.replace("%",""))/100*a),this.virtualSize=-m,r?o.css({marginLeft:"",marginTop:""}):o.css({marginRight:"",marginBottom:""}),e.slidesPerColumn>1&&(w=Math.floor(l/e.slidesPerColumn)===l/this.params.slidesPerColumn?l:Math.ceil(l/e.slidesPerColumn)*e.slidesPerColumn,"auto"!==e.slidesPerView&&"row"===e.slidesPerColumnFill&&(w=Math.max(w,e.slidesPerView*e.slidesPerColumn)));for(var x,$=e.slidesPerColumn,E=w/$,k=Math.floor(l/e.slidesPerColumn),S=0;S<l;S+=1){C=0;var T=o.eq(S);if(e.slidesPerColumn>1){var M=void 0,P=void 0,O=void 0;"column"===e.slidesPerColumnFill?(O=S-(P=Math.floor(S/$))*$,(P>k||P===k&&O===$-1)&&(O+=1)>=$&&(O=0,P+=1),M=P+O*w/$,T.css({"-webkit-box-ordinal-group":M,"-moz-box-ordinal-group":M,"-ms-flex-order":M,"-webkit-order":M,order:M})):P=S-(O=Math.floor(S/E))*E,T.css("margin-"+(this.isHorizontal()?"top":"left"),0!==O&&e.spaceBetween&&e.spaceBetween+"px").attr("data-swiper-column",P).attr("data-swiper-row",O)}if("none"!==T.css("display")){if("auto"===e.slidesPerView){var D=win.getComputedStyle(T[0],null),I=T[0].style.transform,B=T[0].style.webkitTransform;if(I&&(T[0].style.transform="none"),B&&(T[0].style.webkitTransform="none"),e.roundLengths)C=this.isHorizontal()?T.outerWidth(!0):T.outerHeight(!0);else if(this.isHorizontal()){var R=parseFloat(D.getPropertyValue("width")),L=parseFloat(D.getPropertyValue("padding-left")),A=parseFloat(D.getPropertyValue("padding-right")),z=parseFloat(D.getPropertyValue("margin-left")),H=parseFloat(D.getPropertyValue("margin-right")),U=D.getPropertyValue("box-sizing");C=U&&"border-box"===U?R+z+H:R+L+A+z+H}else{var N=parseFloat(D.getPropertyValue("height")),F=parseFloat(D.getPropertyValue("padding-top")),V=parseFloat(D.getPropertyValue("padding-bottom")),j=parseFloat(D.getPropertyValue("margin-top")),q=parseFloat(D.getPropertyValue("margin-bottom")),Y=D.getPropertyValue("box-sizing");C=Y&&"border-box"===Y?N+j+q:N+F+V+j+q}I&&(T[0].style.transform=I),B&&(T[0].style.webkitTransform=B),e.roundLengths&&(C=Math.floor(C))}else C=(a-(e.slidesPerView-1)*m)/e.slidesPerView,e.roundLengths&&(C=Math.floor(C)),o[S]&&(this.isHorizontal()?o[S].style.width=C+"px":o[S].style.height=C+"px");o[S]&&(o[S].swiperSlideSize=C),d.push(C),e.centeredSlides?(g=g+C/2+b/2+m,0===b&&0!==S&&(g=g-a/2-m),0===S&&(g=g-a/2-m),Math.abs(g)<.001&&(g=0),e.roundLengths&&(g=Math.floor(g)),y%e.slidesPerGroup==0&&p.push(g),c.push(g)):(e.roundLengths&&(g=Math.floor(g)),y%e.slidesPerGroup==0&&p.push(g),c.push(g),g=g+C+m),this.virtualSize+=C+m,b=C,y+=1}}if(this.virtualSize=Math.max(this.virtualSize,a)+h,r&&n&&("slide"===e.effect||"coverflow"===e.effect)&&t.css({width:this.virtualSize+e.spaceBetween+"px"}),Support.flexbox&&!e.setWrapperSize||(this.isHorizontal()?t.css({width:this.virtualSize+e.spaceBetween+"px"}):t.css({height:this.virtualSize+e.spaceBetween+"px"})),e.slidesPerColumn>1&&(this.virtualSize=(C+e.spaceBetween)*w,this.virtualSize=Math.ceil(this.virtualSize/e.slidesPerColumn)-e.spaceBetween,this.isHorizontal()?t.css({width:this.virtualSize+e.spaceBetween+"px"}):t.css({height:this.virtualSize+e.spaceBetween+"px"}),e.centeredSlides)){x=[];for(var _=0;_<p.length;_+=1){var W=p[_];e.roundLengths&&(W=Math.floor(W)),p[_]<this.virtualSize+p[0]&&x.push(W)}p=x}if(!e.centeredSlides){x=[];for(var X=0;X<p.length;X+=1){var G=p[X];e.roundLengths&&(G=Math.floor(G)),p[X]<=this.virtualSize-a&&x.push(G)}p=x,Math.floor(this.virtualSize-a)-Math.floor(p[p.length-1])>1&&p.push(this.virtualSize-a)}if(0===p.length&&(p=[0]),0!==e.spaceBetween&&(this.isHorizontal()?r?o.css({marginLeft:m+"px"}):o.css({marginRight:m+"px"}):o.css({marginBottom:m+"px"})),e.centerInsufficientSlides){var J=0;if(d.forEach(function(t){J+=t+(e.spaceBetween?e.spaceBetween:0)}),(J-=e.spaceBetween)<a){var Q=(a-J)/2;p.forEach(function(e,t){p[t]=e-Q}),c.forEach(function(e,t){c[t]=e+Q})}}Utils.extend(this,{slides:o,snapGrid:p,slidesGrid:c,slidesSizesGrid:d}),l!==s&&this.emit("slidesLengthChange"),p.length!==f&&(this.params.watchOverflow&&this.checkOverflow(),this.emit("snapGridLengthChange")),c.length!==v&&this.emit("slidesGridLengthChange"),(e.watchSlidesProgress||e.watchSlidesVisibility)&&this.updateSlidesOffset()}}function updateAutoHeight(e){var t,a=[],r=0;if("number"==typeof e?this.setTransition(e):!0===e&&this.setTransition(this.params.speed),"auto"!==this.params.slidesPerView&&this.params.slidesPerView>1)for(t=0;t<Math.ceil(this.params.slidesPerView);t+=1){var n=this.activeIndex+t;if(n>this.slides.length)break;a.push(this.slides.eq(n)[0])}else a.push(this.slides.eq(this.activeIndex)[0]);for(t=0;t<a.length;t+=1)if(void 0!==a[t]){var i=a[t].offsetHeight;r=i>r?i:r}r&&this.$wrapperEl.css("height",r+"px")}function updateSlidesOffset(){for(var e=this.slides,t=0;t<e.length;t+=1)e[t].swiperSlideOffset=this.isHorizontal()?e[t].offsetLeft:e[t].offsetTop}function updateSlidesProgress(e){void 0===e&&(e=this&&this.translate||0);var t=this.params,a=this.slides,r=this.rtlTranslate;if(0!==a.length){void 0===a[0].swiperSlideOffset&&this.updateSlidesOffset();var n=-e;r&&(n=e),a.removeClass(t.slideVisibleClass),this.visibleSlidesIndexes=[],this.visibleSlides=[];for(var i=0;i<a.length;i+=1){var s=a[i],o=(n+(t.centeredSlides?this.minTranslate():0)-s.swiperSlideOffset)/(s.swiperSlideSize+t.spaceBetween);if(t.watchSlidesVisibility){var l=-(n-s.swiperSlideOffset),p=l+this.slidesSizesGrid[i];(l>=0&&l<this.size||p>0&&p<=this.size||l<=0&&p>=this.size)&&(this.visibleSlides.push(s),this.visibleSlidesIndexes.push(i),a.eq(i).addClass(t.slideVisibleClass))}s.progress=r?-o:o}this.visibleSlides=$(this.visibleSlides)}}function updateProgress(e){void 0===e&&(e=this&&this.translate||0);var t=this.params,a=this.maxTranslate()-this.minTranslate(),r=this.progress,n=this.isBeginning,i=this.isEnd,s=n,o=i;0===a?(r=0,n=!0,i=!0):(n=(r=(e-this.minTranslate())/a)<=0,i=r>=1),Utils.extend(this,{progress:r,isBeginning:n,isEnd:i}),(t.watchSlidesProgress||t.watchSlidesVisibility)&&this.updateSlidesProgress(e),n&&!s&&this.emit("reachBeginning toEdge"),i&&!o&&this.emit("reachEnd toEdge"),(s&&!n||o&&!i)&&this.emit("fromEdge"),this.emit("progress",r)}function updateSlidesClasses(){var e,t=this.slides,a=this.params,r=this.$wrapperEl,n=this.activeIndex,i=this.realIndex,s=this.virtual&&a.virtual.enabled;t.removeClass(a.slideActiveClass+" "+a.slideNextClass+" "+a.slidePrevClass+" "+a.slideDuplicateActiveClass+" "+a.slideDuplicateNextClass+" "+a.slideDuplicatePrevClass),(e=s?this.$wrapperEl.find("."+a.slideClass+'[data-swiper-slide-index="'+n+'"]'):t.eq(n)).addClass(a.slideActiveClass),a.loop&&(e.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+i+'"]').addClass(a.slideDuplicateActiveClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+i+'"]').addClass(a.slideDuplicateActiveClass));var o=e.nextAll("."+a.slideClass).eq(0).addClass(a.slideNextClass);a.loop&&0===o.length&&(o=t.eq(0)).addClass(a.slideNextClass);var l=e.prevAll("."+a.slideClass).eq(0).addClass(a.slidePrevClass);a.loop&&0===l.length&&(l=t.eq(-1)).addClass(a.slidePrevClass),a.loop&&(o.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+o.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicateNextClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+o.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicateNextClass),l.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+l.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicatePrevClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+l.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicatePrevClass))}function updateActiveIndex(e){var t,a=this.rtlTranslate?this.translate:-this.translate,r=this.slidesGrid,n=this.snapGrid,i=this.params,s=this.activeIndex,o=this.realIndex,l=this.snapIndex,p=e;if(void 0===p){for(var c=0;c<r.length;c+=1)void 0!==r[c+1]?a>=r[c]&&a<r[c+1]-(r[c+1]-r[c])/2?p=c:a>=r[c]&&a<r[c+1]&&(p=c+1):a>=r[c]&&(p=c);i.normalizeSlideIndex&&(p<0||void 0===p)&&(p=0)}if((t=n.indexOf(a)>=0?n.indexOf(a):Math.floor(p/i.slidesPerGroup))>=n.length&&(t=n.length-1),p!==s){var d=parseInt(this.slides.eq(p).attr("data-swiper-slide-index")||p,10);Utils.extend(this,{snapIndex:t,realIndex:d,previousIndex:s,activeIndex:p}),this.emit("activeIndexChange"),this.emit("snapIndexChange"),o!==d&&this.emit("realIndexChange"),this.emit("slideChange")}else t!==l&&(this.snapIndex=t,this.emit("snapIndexChange"))}function updateClickedSlide(e){var t=this.params,a=$(e.target).closest("."+t.slideClass)[0],r=!1;if(a)for(var n=0;n<this.slides.length;n+=1)this.slides[n]===a&&(r=!0);if(!a||!r)return this.clickedSlide=void 0,void(this.clickedIndex=void 0);this.clickedSlide=a,this.virtual&&this.params.virtual.enabled?this.clickedIndex=parseInt($(a).attr("data-swiper-slide-index"),10):this.clickedIndex=$(a).index(),t.slideToClickedSlide&&void 0!==this.clickedIndex&&this.clickedIndex!==this.activeIndex&&this.slideToClickedSlide()}var update={updateSize:updateSize,updateSlides:updateSlides,updateAutoHeight:updateAutoHeight,updateSlidesOffset:updateSlidesOffset,updateSlidesProgress:updateSlidesProgress,updateProgress:updateProgress,updateSlidesClasses:updateSlidesClasses,updateActiveIndex:updateActiveIndex,updateClickedSlide:updateClickedSlide};function getTranslate(e){void 0===e&&(e=this.isHorizontal()?"x":"y");var t=this.params,a=this.rtlTranslate,r=this.translate,n=this.$wrapperEl;if(t.virtualTranslate)return a?-r:r;var i=Utils.getTranslate(n[0],e);return a&&(i=-i),i||0}function setTranslate(e,t){var a=this.rtlTranslate,r=this.params,n=this.$wrapperEl,i=this.progress,s=0,o=0;this.isHorizontal()?s=a?-e:e:o=e,r.roundLengths&&(s=Math.floor(s),o=Math.floor(o)),r.virtualTranslate||(Support.transforms3d?n.transform("translate3d("+s+"px, "+o+"px, 0px)"):n.transform("translate("+s+"px, "+o+"px)")),this.previousTranslate=this.translate,this.translate=this.isHorizontal()?s:o;var l=this.maxTranslate()-this.minTranslate();(0===l?0:(e-this.minTranslate())/l)!==i&&this.updateProgress(e),this.emit("setTranslate",this.translate,t)}function minTranslate(){return-this.snapGrid[0]}function maxTranslate(){return-this.snapGrid[this.snapGrid.length-1]}var translate={getTranslate:getTranslate,setTranslate:setTranslate,minTranslate:minTranslate,maxTranslate:maxTranslate};function setTransition(e,t){this.$wrapperEl.transition(e),this.emit("setTransition",e,t)}function transitionStart(e,t){void 0===e&&(e=!0);var a=this.activeIndex,r=this.params,n=this.previousIndex;r.autoHeight&&this.updateAutoHeight();var i=t;if(i||(i=a>n?"next":a<n?"prev":"reset"),this.emit("transitionStart"),e&&a!==n){if("reset"===i)return void this.emit("slideResetTransitionStart");this.emit("slideChangeTransitionStart"),"next"===i?this.emit("slideNextTransitionStart"):this.emit("slidePrevTransitionStart")}}function transitionEnd$1(e,t){void 0===e&&(e=!0);var a=this.activeIndex,r=this.previousIndex;this.animating=!1,this.setTransition(0);var n=t;if(n||(n=a>r?"next":a<r?"prev":"reset"),this.emit("transitionEnd"),e&&a!==r){if("reset"===n)return void this.emit("slideResetTransitionEnd");this.emit("slideChangeTransitionEnd"),"next"===n?this.emit("slideNextTransitionEnd"):this.emit("slidePrevTransitionEnd")}}var transition$1={setTransition:setTransition,transitionStart:transitionStart,transitionEnd:transitionEnd$1};function slideTo(e,t,a,r){void 0===e&&(e=0),void 0===t&&(t=this.params.speed),void 0===a&&(a=!0);var n=this,i=e;i<0&&(i=0);var s=n.params,o=n.snapGrid,l=n.slidesGrid,p=n.previousIndex,c=n.activeIndex,d=n.rtlTranslate;if(n.animating&&s.preventInteractionOnTransition)return!1;var u=Math.floor(i/s.slidesPerGroup);u>=o.length&&(u=o.length-1),(c||s.initialSlide||0)===(p||0)&&a&&n.emit("beforeSlideChangeStart");var h,f=-o[u];if(n.updateProgress(f),s.normalizeSlideIndex)for(var v=0;v<l.length;v+=1)-Math.floor(100*f)>=Math.floor(100*l[v])&&(i=v);if(n.initialized&&i!==c){if(!n.allowSlideNext&&f<n.translate&&f<n.minTranslate())return!1;if(!n.allowSlidePrev&&f>n.translate&&f>n.maxTranslate()&&(c||0)!==i)return!1}return h=i>c?"next":i<c?"prev":"reset",d&&-f===n.translate||!d&&f===n.translate?(n.updateActiveIndex(i),s.autoHeight&&n.updateAutoHeight(),n.updateSlidesClasses(),"slide"!==s.effect&&n.setTranslate(f),"reset"!==h&&(n.transitionStart(a,h),n.transitionEnd(a,h)),!1):(0!==t&&Support.transition?(n.setTransition(t),n.setTranslate(f),n.updateActiveIndex(i),n.updateSlidesClasses(),n.emit("beforeTransitionStart",t,r),n.transitionStart(a,h),n.animating||(n.animating=!0,n.onSlideToWrapperTransitionEnd||(n.onSlideToWrapperTransitionEnd=function(e){n&&!n.destroyed&&e.target===this&&(n.$wrapperEl[0].removeEventListener("transitionend",n.onSlideToWrapperTransitionEnd),n.$wrapperEl[0].removeEventListener("webkitTransitionEnd",n.onSlideToWrapperTransitionEnd),n.onSlideToWrapperTransitionEnd=null,delete n.onSlideToWrapperTransitionEnd,n.transitionEnd(a,h))}),n.$wrapperEl[0].addEventListener("transitionend",n.onSlideToWrapperTransitionEnd),n.$wrapperEl[0].addEventListener("webkitTransitionEnd",n.onSlideToWrapperTransitionEnd))):(n.setTransition(0),n.setTranslate(f),n.updateActiveIndex(i),n.updateSlidesClasses(),n.emit("beforeTransitionStart",t,r),n.transitionStart(a,h),n.transitionEnd(a,h)),!0)}function slideToLoop(e,t,a,r){void 0===e&&(e=0),void 0===t&&(t=this.params.speed),void 0===a&&(a=!0);var n=e;return this.params.loop&&(n+=this.loopedSlides),this.slideTo(n,t,a,r)}function slideNext(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.params,n=this.animating;return r.loop?!n&&(this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft,this.slideTo(this.activeIndex+r.slidesPerGroup,e,t,a)):this.slideTo(this.activeIndex+r.slidesPerGroup,e,t,a)}function slidePrev(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.params,n=this.animating,i=this.snapGrid,s=this.slidesGrid,o=this.rtlTranslate;if(r.loop){if(n)return!1;this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft}function l(e){return e<0?-Math.floor(Math.abs(e)):Math.floor(e)}var p,c=l(o?this.translate:-this.translate),d=i.map(function(e){return l(e)}),u=(s.map(function(e){return l(e)}),i[d.indexOf(c)],i[d.indexOf(c)-1]);return void 0!==u&&(p=s.indexOf(u))<0&&(p=this.activeIndex-1),this.slideTo(p,e,t,a)}function slideReset(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);return this.slideTo(this.activeIndex,e,t,a)}function slideToClosest(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.activeIndex,n=Math.floor(r/this.params.slidesPerGroup);if(n<this.snapGrid.length-1){var i=this.rtlTranslate?this.translate:-this.translate,s=this.snapGrid[n];i-s>(this.snapGrid[n+1]-s)/2&&(r=this.params.slidesPerGroup)}return this.slideTo(r,e,t,a)}function slideToClickedSlide(){var e,t=this,a=t.params,r=t.$wrapperEl,n="auto"===a.slidesPerView?t.slidesPerViewDynamic():a.slidesPerView,i=t.clickedIndex;if(a.loop){if(t.animating)return;e=parseInt($(t.clickedSlide).attr("data-swiper-slide-index"),10),a.centeredSlides?i<t.loopedSlides-n/2||i>t.slides.length-t.loopedSlides+n/2?(t.loopFix(),i=r.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]:not(.'+a.slideDuplicateClass+")").eq(0).index(),Utils.nextTick(function(){t.slideTo(i)})):t.slideTo(i):i>t.slides.length-n?(t.loopFix(),i=r.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]:not(.'+a.slideDuplicateClass+")").eq(0).index(),Utils.nextTick(function(){t.slideTo(i)})):t.slideTo(i)}else t.slideTo(i)}var slide={slideTo:slideTo,slideToLoop:slideToLoop,slideNext:slideNext,slidePrev:slidePrev,slideReset:slideReset,slideToClosest:slideToClosest,slideToClickedSlide:slideToClickedSlide};function loopCreate(){var e=this,t=e.params,a=e.$wrapperEl;a.children("."+t.slideClass+"."+t.slideDuplicateClass).remove();var r=a.children("."+t.slideClass);if(t.loopFillGroupWithBlank){var n=t.slidesPerGroup-r.length%t.slidesPerGroup;if(n!==t.slidesPerGroup){for(var i=0;i<n;i+=1){var s=$(doc.createElement("div")).addClass(t.slideClass+" "+t.slideBlankClass);a.append(s)}r=a.children("."+t.slideClass)}}"auto"!==t.slidesPerView||t.loopedSlides||(t.loopedSlides=r.length),e.loopedSlides=parseInt(t.loopedSlides||t.slidesPerView,10),e.loopedSlides+=t.loopAdditionalSlides,e.loopedSlides>r.length&&(e.loopedSlides=r.length);var o=[],l=[];r.each(function(t,a){var n=$(a);t<e.loopedSlides&&l.push(a),t<r.length&&t>=r.length-e.loopedSlides&&o.push(a),n.attr("data-swiper-slide-index",t)});for(var p=0;p<l.length;p+=1)a.append($(l[p].cloneNode(!0)).addClass(t.slideDuplicateClass));for(var c=o.length-1;c>=0;c-=1)a.prepend($(o[c].cloneNode(!0)).addClass(t.slideDuplicateClass))}function loopFix(){var e,t=this.params,a=this.activeIndex,r=this.slides,n=this.loopedSlides,i=this.allowSlidePrev,s=this.allowSlideNext,o=this.snapGrid,l=this.rtlTranslate;this.allowSlidePrev=!0,this.allowSlideNext=!0;var p=-o[a]-this.getTranslate();if(a<n)e=r.length-3*n+a,e+=n,this.slideTo(e,0,!1,!0)&&0!==p&&this.setTranslate((l?-this.translate:this.translate)-p);else if("auto"===t.slidesPerView&&a>=2*n||a>=r.length-n){e=-r.length+a+n,e+=n,this.slideTo(e,0,!1,!0)&&0!==p&&this.setTranslate((l?-this.translate:this.translate)-p)}this.allowSlidePrev=i,this.allowSlideNext=s}function loopDestroy(){var e=this.$wrapperEl,t=this.params,a=this.slides;e.children("."+t.slideClass+"."+t.slideDuplicateClass+",."+t.slideClass+"."+t.slideBlankClass).remove(),a.removeAttr("data-swiper-slide-index")}var loop={loopCreate:loopCreate,loopFix:loopFix,loopDestroy:loopDestroy};function setGrabCursor(e){if(!(Support.touch||!this.params.simulateTouch||this.params.watchOverflow&&this.isLocked)){var t=this.el;t.style.cursor="move",t.style.cursor=e?"-webkit-grabbing":"-webkit-grab",t.style.cursor=e?"-moz-grabbin":"-moz-grab",t.style.cursor=e?"grabbing":"grab"}}function unsetGrabCursor(){Support.touch||this.params.watchOverflow&&this.isLocked||(this.el.style.cursor="")}var grabCursor={setGrabCursor:setGrabCursor,unsetGrabCursor:unsetGrabCursor};function appendSlide(e){var t=this.$wrapperEl,a=this.params;if(a.loop&&this.loopDestroy(),"object"==typeof e&&"length"in e)for(var r=0;r<e.length;r+=1)e[r]&&t.append(e[r]);else t.append(e);a.loop&&this.loopCreate(),a.observer&&Support.observer||this.update()}function prependSlide(e){var t=this.params,a=this.$wrapperEl,r=this.activeIndex;t.loop&&this.loopDestroy();var n=r+1;if("object"==typeof e&&"length"in e){for(var i=0;i<e.length;i+=1)e[i]&&a.prepend(e[i]);n=r+e.length}else a.prepend(e);t.loop&&this.loopCreate(),t.observer&&Support.observer||this.update(),this.slideTo(n,0,!1)}function addSlide(e,t){var a=this.$wrapperEl,r=this.params,n=this.activeIndex;r.loop&&(n-=this.loopedSlides,this.loopDestroy(),this.slides=a.children("."+r.slideClass));var i=this.slides.length;if(e<=0)this.prependSlide(t);else if(e>=i)this.appendSlide(t);else{for(var s=n>e?n+1:n,o=[],l=i-1;l>=e;l-=1){var p=this.slides.eq(l);p.remove(),o.unshift(p)}if("object"==typeof t&&"length"in t){for(var c=0;c<t.length;c+=1)t[c]&&a.append(t[c]);s=n>e?n+t.length:n}else a.append(t);for(var d=0;d<o.length;d+=1)a.append(o[d]);r.loop&&this.loopCreate(),r.observer&&Support.observer||this.update(),r.loop?this.slideTo(s+this.loopedSlides,0,!1):this.slideTo(s,0,!1)}}function removeSlide(e){var t=this.params,a=this.$wrapperEl,r=this.activeIndex;t.loop&&(r-=this.loopedSlides,this.loopDestroy(),this.slides=a.children("."+t.slideClass));var n,i=r;if("object"==typeof e&&"length"in e){for(var s=0;s<e.length;s+=1)n=e[s],this.slides[n]&&this.slides.eq(n).remove(),n<i&&(i-=1);i=Math.max(i,0)}else n=e,this.slides[n]&&this.slides.eq(n).remove(),n<i&&(i-=1),i=Math.max(i,0);t.loop&&this.loopCreate(),t.observer&&Support.observer||this.update(),t.loop?this.slideTo(i+this.loopedSlides,0,!1):this.slideTo(i,0,!1)}function removeAllSlides(){for(var e=[],t=0;t<this.slides.length;t+=1)e.push(t);this.removeSlide(e)}var manipulation={appendSlide:appendSlide,prependSlide:prependSlide,addSlide:addSlide,removeSlide:removeSlide,removeAllSlides:removeAllSlides};function onTouchStart(e){var t=this.touchEventsData,a=this.params,r=this.touches;if(!this.animating||!a.preventInteractionOnTransition){var n=e;if(n.originalEvent&&(n=n.originalEvent),t.isTouchEvent="touchstart"===n.type,(t.isTouchEvent||!("which"in n)||3!==n.which)&&!(!t.isTouchEvent&&"button"in n&&n.button>0||t.isTouched&&t.isMoved))if(a.noSwiping&&$(n.target).closest(a.noSwipingSelector?a.noSwipingSelector:"."+a.noSwipingClass)[0])this.allowClick=!0;else if(!a.swipeHandler||$(n).closest(a.swipeHandler)[0]){r.currentX="touchstart"===n.type?n.targetTouches[0].pageX:n.pageX,r.currentY="touchstart"===n.type?n.targetTouches[0].pageY:n.pageY;var i=r.currentX,s=r.currentY,o=a.edgeSwipeDetection||a.iOSEdgeSwipeDetection,l=a.edgeSwipeThreshold||a.iOSEdgeSwipeThreshold;if(!o||!(i<=l||i>=win.screen.width-l)){if(Utils.extend(t,{isTouched:!0,isMoved:!1,allowTouchCallbacks:!0,isScrolling:void 0,startMoving:void 0}),r.startX=i,r.startY=s,t.touchStartTime=Utils.now(),this.allowClick=!0,this.updateSize(),this.swipeDirection=void 0,a.threshold>0&&(t.allowThresholdMove=!1),"touchstart"!==n.type){var p=!0;$(n.target).is(t.formElements)&&(p=!1),doc.activeElement&&$(doc.activeElement).is(t.formElements)&&doc.activeElement!==n.target&&doc.activeElement.blur();var c=p&&this.allowTouchMove&&a.touchStartPreventDefault;(a.touchStartForcePreventDefault||c)&&n.preventDefault()}this.emit("touchStart",n)}}}}function onTouchMove(e){var t=this.touchEventsData,a=this.params,r=this.touches,n=this.rtlTranslate,i=e;if(i.originalEvent&&(i=i.originalEvent),t.isTouched){if(!t.isTouchEvent||"mousemove"!==i.type){var s="touchmove"===i.type?i.targetTouches[0].pageX:i.pageX,o="touchmove"===i.type?i.targetTouches[0].pageY:i.pageY;if(i.preventedByNestedSwiper)return r.startX=s,void(r.startY=o);if(!this.allowTouchMove)return this.allowClick=!1,void(t.isTouched&&(Utils.extend(r,{startX:s,startY:o,currentX:s,currentY:o}),t.touchStartTime=Utils.now()));if(t.isTouchEvent&&a.touchReleaseOnEdges&&!a.loop)if(this.isVertical()){if(o<r.startY&&this.translate<=this.maxTranslate()||o>r.startY&&this.translate>=this.minTranslate())return t.isTouched=!1,void(t.isMoved=!1)}else if(s<r.startX&&this.translate<=this.maxTranslate()||s>r.startX&&this.translate>=this.minTranslate())return;if(t.isTouchEvent&&doc.activeElement&&i.target===doc.activeElement&&$(i.target).is(t.formElements))return t.isMoved=!0,void(this.allowClick=!1);if(t.allowTouchCallbacks&&this.emit("touchMove",i),!(i.targetTouches&&i.targetTouches.length>1)){r.currentX=s,r.currentY=o;var l=r.currentX-r.startX,p=r.currentY-r.startY;if(!(this.params.threshold&&Math.sqrt(Math.pow(l,2)+Math.pow(p,2))<this.params.threshold)){var c;if(void 0===t.isScrolling)this.isHorizontal()&&r.currentY===r.startY||this.isVertical()&&r.currentX===r.startX?t.isScrolling=!1:l*l+p*p>=25&&(c=180*Math.atan2(Math.abs(p),Math.abs(l))/Math.PI,t.isScrolling=this.isHorizontal()?c>a.touchAngle:90-c>a.touchAngle);if(t.isScrolling&&this.emit("touchMoveOpposite",i),void 0===t.startMoving&&(r.currentX===r.startX&&r.currentY===r.startY||(t.startMoving=!0)),t.isScrolling)t.isTouched=!1;else if(t.startMoving){this.allowClick=!1,i.preventDefault(),a.touchMoveStopPropagation&&!a.nested&&i.stopPropagation(),t.isMoved||(a.loop&&this.loopFix(),t.startTranslate=this.getTranslate(),this.setTransition(0),this.animating&&this.$wrapperEl.trigger("webkitTransitionEnd transitionend"),t.allowMomentumBounce=!1,!a.grabCursor||!0!==this.allowSlideNext&&!0!==this.allowSlidePrev||this.setGrabCursor(!0),this.emit("sliderFirstMove",i)),this.emit("sliderMove",i),t.isMoved=!0;var d=this.isHorizontal()?l:p;r.diff=d,d*=a.touchRatio,n&&(d=-d),this.swipeDirection=d>0?"prev":"next",t.currentTranslate=d+t.startTranslate;var u=!0,h=a.resistanceRatio;if(a.touchReleaseOnEdges&&(h=0),d>0&&t.currentTranslate>this.minTranslate()?(u=!1,a.resistance&&(t.currentTranslate=this.minTranslate()-1+Math.pow(-this.minTranslate()+t.startTranslate+d,h))):d<0&&t.currentTranslate<this.maxTranslate()&&(u=!1,a.resistance&&(t.currentTranslate=this.maxTranslate()+1-Math.pow(this.maxTranslate()-t.startTranslate-d,h))),u&&(i.preventedByNestedSwiper=!0),!this.allowSlideNext&&"next"===this.swipeDirection&&t.currentTranslate<t.startTranslate&&(t.currentTranslate=t.startTranslate),!this.allowSlidePrev&&"prev"===this.swipeDirection&&t.currentTranslate>t.startTranslate&&(t.currentTranslate=t.startTranslate),a.threshold>0){if(!(Math.abs(d)>a.threshold||t.allowThresholdMove))return void(t.currentTranslate=t.startTranslate);if(!t.allowThresholdMove)return t.allowThresholdMove=!0,r.startX=r.currentX,r.startY=r.currentY,t.currentTranslate=t.startTranslate,void(r.diff=this.isHorizontal()?r.currentX-r.startX:r.currentY-r.startY)}a.followFinger&&((a.freeMode||a.watchSlidesProgress||a.watchSlidesVisibility)&&(this.updateActiveIndex(),this.updateSlidesClasses()),a.freeMode&&(0===t.velocities.length&&t.velocities.push({position:r[this.isHorizontal()?"startX":"startY"],time:t.touchStartTime}),t.velocities.push({position:r[this.isHorizontal()?"currentX":"currentY"],time:Utils.now()})),this.updateProgress(t.currentTranslate),this.setTranslate(t.currentTranslate))}}}}}else t.startMoving&&t.isScrolling&&this.emit("touchMoveOpposite",i)}function onTouchEnd(e){var t=this,a=t.touchEventsData,r=t.params,n=t.touches,i=t.rtlTranslate,s=t.$wrapperEl,o=t.slidesGrid,l=t.snapGrid,p=e;if(p.originalEvent&&(p=p.originalEvent),a.allowTouchCallbacks&&t.emit("touchEnd",p),a.allowTouchCallbacks=!1,!a.isTouched)return a.isMoved&&r.grabCursor&&t.setGrabCursor(!1),a.isMoved=!1,void(a.startMoving=!1);r.grabCursor&&a.isMoved&&a.isTouched&&(!0===t.allowSlideNext||!0===t.allowSlidePrev)&&t.setGrabCursor(!1);var c,d=Utils.now(),u=d-a.touchStartTime;if(t.allowClick&&(t.updateClickedSlide(p),t.emit("tap",p),u<300&&d-a.lastClickTime>300&&(a.clickTimeout&&clearTimeout(a.clickTimeout),a.clickTimeout=Utils.nextTick(function(){t&&!t.destroyed&&t.emit("click",p)},300)),u<300&&d-a.lastClickTime<300&&(a.clickTimeout&&clearTimeout(a.clickTimeout),t.emit("doubleTap",p))),a.lastClickTime=Utils.now(),Utils.nextTick(function(){t.destroyed||(t.allowClick=!0)}),!a.isTouched||!a.isMoved||!t.swipeDirection||0===n.diff||a.currentTranslate===a.startTranslate)return a.isTouched=!1,a.isMoved=!1,void(a.startMoving=!1);if(a.isTouched=!1,a.isMoved=!1,a.startMoving=!1,c=r.followFinger?i?t.translate:-t.translate:-a.currentTranslate,r.freeMode){if(c<-t.minTranslate())return void t.slideTo(t.activeIndex);if(c>-t.maxTranslate())return void(t.slides.length<l.length?t.slideTo(l.length-1):t.slideTo(t.slides.length-1));if(r.freeModeMomentum){if(a.velocities.length>1){var h=a.velocities.pop(),f=a.velocities.pop(),v=h.position-f.position,m=h.time-f.time;t.velocity=v/m,t.velocity/=2,Math.abs(t.velocity)<r.freeModeMinimumVelocity&&(t.velocity=0),(m>150||Utils.now()-h.time>300)&&(t.velocity=0)}else t.velocity=0;t.velocity*=r.freeModeMomentumVelocityRatio,a.velocities.length=0;var g=1e3*r.freeModeMomentumRatio,b=t.velocity*g,y=t.translate+b;i&&(y=-y);var w,C,x=!1,$=20*Math.abs(t.velocity)*r.freeModeMomentumBounceRatio;if(y<t.maxTranslate())r.freeModeMomentumBounce?(y+t.maxTranslate()<-$&&(y=t.maxTranslate()-$),w=t.maxTranslate(),x=!0,a.allowMomentumBounce=!0):y=t.maxTranslate(),r.loop&&r.centeredSlides&&(C=!0);else if(y>t.minTranslate())r.freeModeMomentumBounce?(y-t.minTranslate()>$&&(y=t.minTranslate()+$),w=t.minTranslate(),x=!0,a.allowMomentumBounce=!0):y=t.minTranslate(),r.loop&&r.centeredSlides&&(C=!0);else if(r.freeModeSticky){for(var E,k=0;k<l.length;k+=1)if(l[k]>-y){E=k;break}y=-(y=Math.abs(l[E]-y)<Math.abs(l[E-1]-y)||"next"===t.swipeDirection?l[E]:l[E-1])}if(C&&t.once("transitionEnd",function(){t.loopFix()}),0!==t.velocity)g=i?Math.abs((-y-t.translate)/t.velocity):Math.abs((y-t.translate)/t.velocity);else if(r.freeModeSticky)return void t.slideToClosest();r.freeModeMomentumBounce&&x?(t.updateProgress(w),t.setTransition(g),t.setTranslate(y),t.transitionStart(!0,t.swipeDirection),t.animating=!0,s.transitionEnd(function(){t&&!t.destroyed&&a.allowMomentumBounce&&(t.emit("momentumBounce"),t.setTransition(r.speed),t.setTranslate(w),s.transitionEnd(function(){t&&!t.destroyed&&t.transitionEnd()}))})):t.velocity?(t.updateProgress(y),t.setTransition(g),t.setTranslate(y),t.transitionStart(!0,t.swipeDirection),t.animating||(t.animating=!0,s.transitionEnd(function(){t&&!t.destroyed&&t.transitionEnd()}))):t.updateProgress(y),t.updateActiveIndex(),t.updateSlidesClasses()}else if(r.freeModeSticky)return void t.slideToClosest();(!r.freeModeMomentum||u>=r.longSwipesMs)&&(t.updateProgress(),t.updateActiveIndex(),t.updateSlidesClasses())}else{for(var S=0,T=t.slidesSizesGrid[0],M=0;M<o.length;M+=r.slidesPerGroup)void 0!==o[M+r.slidesPerGroup]?c>=o[M]&&c<o[M+r.slidesPerGroup]&&(S=M,T=o[M+r.slidesPerGroup]-o[M]):c>=o[M]&&(S=M,T=o[o.length-1]-o[o.length-2]);var P=(c-o[S])/T;if(u>r.longSwipesMs){if(!r.longSwipes)return void t.slideTo(t.activeIndex);"next"===t.swipeDirection&&(P>=r.longSwipesRatio?t.slideTo(S+r.slidesPerGroup):t.slideTo(S)),"prev"===t.swipeDirection&&(P>1-r.longSwipesRatio?t.slideTo(S+r.slidesPerGroup):t.slideTo(S))}else{if(!r.shortSwipes)return void t.slideTo(t.activeIndex);"next"===t.swipeDirection&&t.slideTo(S+r.slidesPerGroup),"prev"===t.swipeDirection&&t.slideTo(S)}}}function onResize(){var e=this.params,t=this.el;if(!t||0!==t.offsetWidth){e.breakpoints&&this.setBreakpoint();var a=this.allowSlideNext,r=this.allowSlidePrev,n=this.snapGrid;if(this.allowSlideNext=!0,this.allowSlidePrev=!0,this.updateSize(),this.updateSlides(),e.freeMode){var i=Math.min(Math.max(this.translate,this.maxTranslate()),this.minTranslate());this.setTranslate(i),this.updateActiveIndex(),this.updateSlidesClasses(),e.autoHeight&&this.updateAutoHeight()}else this.updateSlidesClasses(),("auto"===e.slidesPerView||e.slidesPerView>1)&&this.isEnd&&!this.params.centeredSlides?this.slideTo(this.slides.length-1,0,!1,!0):this.slideTo(this.activeIndex,0,!1,!0);this.allowSlidePrev=r,this.allowSlideNext=a,this.params.watchOverflow&&n!==this.snapGrid&&this.checkOverflow()}}function onClick(e){this.allowClick||(this.params.preventClicks&&e.preventDefault(),this.params.preventClicksPropagation&&this.animating&&(e.stopPropagation(),e.stopImmediatePropagation()))}function attachEvents(){var e=this.params,t=this.touchEvents,a=this.el,r=this.wrapperEl;this.onTouchStart=onTouchStart.bind(this),this.onTouchMove=onTouchMove.bind(this),this.onTouchEnd=onTouchEnd.bind(this),this.onClick=onClick.bind(this);var n="container"===e.touchEventsTarget?a:r,i=!!e.nested;if(Support.touch||!Support.pointerEvents&&!Support.prefixedPointerEvents){if(Support.touch){var s=!("touchstart"!==t.start||!Support.passiveListener||!e.passiveListeners)&&{passive:!0,capture:!1};n.addEventListener(t.start,this.onTouchStart,s),n.addEventListener(t.move,this.onTouchMove,Support.passiveListener?{passive:!1,capture:i}:i),n.addEventListener(t.end,this.onTouchEnd,s)}(e.simulateTouch&&!Device.ios&&!Device.android||e.simulateTouch&&!Support.touch&&Device.ios)&&(n.addEventListener("mousedown",this.onTouchStart,!1),doc.addEventListener("mousemove",this.onTouchMove,i),doc.addEventListener("mouseup",this.onTouchEnd,!1))}else n.addEventListener(t.start,this.onTouchStart,!1),doc.addEventListener(t.move,this.onTouchMove,i),doc.addEventListener(t.end,this.onTouchEnd,!1);(e.preventClicks||e.preventClicksPropagation)&&n.addEventListener("click",this.onClick,!0),this.on(Device.ios||Device.android?"resize orientationchange observerUpdate":"resize observerUpdate",onResize,!0)}function detachEvents(){var e=this.params,t=this.touchEvents,a=this.el,r=this.wrapperEl,n="container"===e.touchEventsTarget?a:r,i=!!e.nested;if(Support.touch||!Support.pointerEvents&&!Support.prefixedPointerEvents){if(Support.touch){var s=!("onTouchStart"!==t.start||!Support.passiveListener||!e.passiveListeners)&&{passive:!0,capture:!1};n.removeEventListener(t.start,this.onTouchStart,s),n.removeEventListener(t.move,this.onTouchMove,i),n.removeEventListener(t.end,this.onTouchEnd,s)}(e.simulateTouch&&!Device.ios&&!Device.android||e.simulateTouch&&!Support.touch&&Device.ios)&&(n.removeEventListener("mousedown",this.onTouchStart,!1),doc.removeEventListener("mousemove",this.onTouchMove,i),doc.removeEventListener("mouseup",this.onTouchEnd,!1))}else n.removeEventListener(t.start,this.onTouchStart,!1),doc.removeEventListener(t.move,this.onTouchMove,i),doc.removeEventListener(t.end,this.onTouchEnd,!1);(e.preventClicks||e.preventClicksPropagation)&&n.removeEventListener("click",this.onClick,!0),this.off(Device.ios||Device.android?"resize orientationchange observerUpdate":"resize observerUpdate",onResize)}var events={attachEvents:attachEvents,detachEvents:detachEvents};function setBreakpoint(){var e=this.activeIndex,t=this.initialized,a=this.loopedSlides;void 0===a&&(a=0);var r=this.params,n=r.breakpoints;if(n&&(!n||0!==Object.keys(n).length)){var i=this.getBreakpoint(n);if(i&&this.currentBreakpoint!==i){var s=i in n?n[i]:void 0;s&&["slidesPerView","spaceBetween","slidesPerGroup"].forEach(function(e){var t=s[e];void 0!==t&&(s[e]="slidesPerView"!==e||"AUTO"!==t&&"auto"!==t?"slidesPerView"===e?parseFloat(t):parseInt(t,10):"auto")});var o=s||this.originalParams,l=o.direction&&o.direction!==r.direction,p=r.loop&&(o.slidesPerView!==r.slidesPerView||l);l&&t&&this.changeDirection(),Utils.extend(this.params,o),Utils.extend(this,{allowTouchMove:this.params.allowTouchMove,allowSlideNext:this.params.allowSlideNext,allowSlidePrev:this.params.allowSlidePrev}),this.currentBreakpoint=i,p&&t&&(this.loopDestroy(),this.loopCreate(),this.updateSlides(),this.slideTo(e-a+this.loopedSlides,0,!1)),this.emit("breakpoint",o)}}}function getBreakpoint(e){if(e){var t=!1,a=[];Object.keys(e).forEach(function(e){a.push(e)}),a.sort(function(e,t){return parseInt(e,10)-parseInt(t,10)});for(var r=0;r<a.length;r+=1){var n=a[r];this.params.breakpointsInverse?n<=win.innerWidth&&(t=n):n>=win.innerWidth&&!t&&(t=n)}return t||"max"}}var breakpoints={setBreakpoint:setBreakpoint,getBreakpoint:getBreakpoint};function addClasses(){var e=this.classNames,t=this.params,a=this.rtl,r=this.$el,n=[];n.push("initialized"),n.push(t.direction),t.freeMode&&n.push("free-mode"),Support.flexbox||n.push("no-flexbox"),t.autoHeight&&n.push("autoheight"),a&&n.push("rtl"),t.slidesPerColumn>1&&n.push("multirow"),Device.android&&n.push("android"),Device.ios&&n.push("ios"),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&n.push("wp8-"+t.direction),n.forEach(function(a){e.push(t.containerModifierClass+a)}),r.addClass(e.join(" "))}function removeClasses(){var e=this.$el,t=this.classNames;e.removeClass(t.join(" "))}var classes={addClasses:addClasses,removeClasses:removeClasses};function loadImage(e,t,a,r,n,i){var s;function o(){i&&i()}e.complete&&n?o():t?((s=new win.Image).onload=o,s.onerror=o,r&&(s.sizes=r),a&&(s.srcset=a),t&&(s.src=t)):o()}function preloadImages(){var e=this;function t(){null!=e&&e&&!e.destroyed&&(void 0!==e.imagesLoaded&&(e.imagesLoaded+=1),e.imagesLoaded===e.imagesToLoad.length&&(e.params.updateOnImagesReady&&e.update(),e.emit("imagesReady")))}e.imagesToLoad=e.$el.find("img");for(var a=0;a<e.imagesToLoad.length;a+=1){var r=e.imagesToLoad[a];e.loadImage(r,r.currentSrc||r.getAttribute("src"),r.srcset||r.getAttribute("srcset"),r.sizes||r.getAttribute("sizes"),!0,t)}}var images={loadImage:loadImage,preloadImages:preloadImages};function checkOverflow(){var e=this.isLocked;this.isLocked=1===this.snapGrid.length,this.allowSlideNext=!this.isLocked,this.allowSlidePrev=!this.isLocked,e!==this.isLocked&&this.emit(this.isLocked?"lock":"unlock"),e&&e!==this.isLocked&&(this.isEnd=!1,this.navigation.update())}var checkOverflow$1={checkOverflow:checkOverflow},defaults={init:!0,direction:"horizontal",touchEventsTarget:"container",initialSlide:0,speed:300,preventInteractionOnTransition:!1,edgeSwipeDetection:!1,edgeSwipeThreshold:20,freeMode:!1,freeModeMomentum:!0,freeModeMomentumRatio:1,freeModeMomentumBounce:!0,freeModeMomentumBounceRatio:1,freeModeMomentumVelocityRatio:1,freeModeSticky:!1,freeModeMinimumVelocity:.02,autoHeight:!1,setWrapperSize:!1,virtualTranslate:!1,effect:"slide",breakpoints:void 0,breakpointsInverse:!1,spaceBetween:0,slidesPerView:1,slidesPerColumn:1,slidesPerColumnFill:"column",slidesPerGroup:1,centeredSlides:!1,slidesOffsetBefore:0,slidesOffsetAfter:0,normalizeSlideIndex:!0,centerInsufficientSlides:!1,watchOverflow:!1,roundLengths:!1,touchRatio:1,touchAngle:45,simulateTouch:!0,shortSwipes:!0,longSwipes:!0,longSwipesRatio:.5,longSwipesMs:300,followFinger:!0,allowTouchMove:!0,threshold:0,touchMoveStopPropagation:!0,touchStartPreventDefault:!0,touchStartForcePreventDefault:!1,touchReleaseOnEdges:!1,uniqueNavElements:!0,resistance:!0,resistanceRatio:.85,watchSlidesProgress:!1,watchSlidesVisibility:!1,grabCursor:!1,preventClicks:!0,preventClicksPropagation:!0,slideToClickedSlide:!1,preloadImages:!0,updateOnImagesReady:!0,loop:!1,loopAdditionalSlides:0,loopedSlides:null,loopFillGroupWithBlank:!1,allowSlidePrev:!0,allowSlideNext:!0,swipeHandler:null,noSwiping:!0,noSwipingClass:"swiper-no-swiping",noSwipingSelector:null,passiveListeners:!0,containerModifierClass:"swiper-container-",slideClass:"swiper-slide",slideBlankClass:"swiper-slide-invisible-blank",slideActiveClass:"swiper-slide-active",slideDuplicateActiveClass:"swiper-slide-duplicate-active",slideVisibleClass:"swiper-slide-visible",slideDuplicateClass:"swiper-slide-duplicate",slideNextClass:"swiper-slide-next",slideDuplicateNextClass:"swiper-slide-duplicate-next",slidePrevClass:"swiper-slide-prev",slideDuplicatePrevClass:"swiper-slide-duplicate-prev",wrapperClass:"swiper-wrapper",runCallbacksOnInit:!0},prototypes={update:update,translate:translate,transition:transition$1,slide:slide,loop:loop,grabCursor:grabCursor,manipulation:manipulation,events:events,breakpoints:breakpoints,checkOverflow:checkOverflow$1,classes:classes,images:images},extendedDefaults={},Swiper=function(e){function t(){for(var a,r,n,i=[],s=arguments.length;s--;)i[s]=arguments[s];1===i.length&&i[0].constructor&&i[0].constructor===Object?n=i[0]:(r=(a=i)[0],n=a[1]),n||(n={}),n=Utils.extend({},n),r&&!n.el&&(n.el=r),e.call(this,n),Object.keys(prototypes).forEach(function(e){Object.keys(prototypes[e]).forEach(function(a){t.prototype[a]||(t.prototype[a]=prototypes[e][a])})});var o=this;void 0===o.modules&&(o.modules={}),Object.keys(o.modules).forEach(function(e){var t=o.modules[e];if(t.params){var a=Object.keys(t.params)[0],r=t.params[a];if("object"!=typeof r||null===r)return;if(!(a in n&&"enabled"in r))return;!0===n[a]&&(n[a]={enabled:!0}),"object"!=typeof n[a]||"enabled"in n[a]||(n[a].enabled=!0),n[a]||(n[a]={enabled:!1})}});var l=Utils.extend({},defaults);o.useModulesParams(l),o.params=Utils.extend({},l,extendedDefaults,n),o.originalParams=Utils.extend({},o.params),o.passedParams=Utils.extend({},n),o.$=$;var p=$(o.params.el);if(r=p[0]){if(p.length>1){var c=[];return p.each(function(e,a){var r=Utils.extend({},n,{el:a});c.push(new t(r))}),c}r.swiper=o,p.data("swiper",o);var d,u,h=p.children("."+o.params.wrapperClass);return Utils.extend(o,{$el:p,el:r,$wrapperEl:h,wrapperEl:h[0],classNames:[],slides:$(),slidesGrid:[],snapGrid:[],slidesSizesGrid:[],isHorizontal:function(){return"horizontal"===o.params.direction},isVertical:function(){return"vertical"===o.params.direction},rtl:"rtl"===r.dir.toLowerCase()||"rtl"===p.css("direction"),rtlTranslate:"horizontal"===o.params.direction&&("rtl"===r.dir.toLowerCase()||"rtl"===p.css("direction")),wrongRTL:"-webkit-box"===h.css("display"),activeIndex:0,realIndex:0,isBeginning:!0,isEnd:!1,translate:0,previousTranslate:0,progress:0,velocity:0,animating:!1,allowSlideNext:o.params.allowSlideNext,allowSlidePrev:o.params.allowSlidePrev,touchEvents:(d=["touchstart","touchmove","touchend"],u=["mousedown","mousemove","mouseup"],Support.pointerEvents?u=["pointerdown","pointermove","pointerup"]:Support.prefixedPointerEvents&&(u=["MSPointerDown","MSPointerMove","MSPointerUp"]),o.touchEventsTouch={start:d[0],move:d[1],end:d[2]},o.touchEventsDesktop={start:u[0],move:u[1],end:u[2]},Support.touch||!o.params.simulateTouch?o.touchEventsTouch:o.touchEventsDesktop),touchEventsData:{isTouched:void 0,isMoved:void 0,allowTouchCallbacks:void 0,touchStartTime:void 0,isScrolling:void 0,currentTranslate:void 0,startTranslate:void 0,allowThresholdMove:void 0,formElements:"input, select, option, textarea, button, video",lastClickTime:Utils.now(),clickTimeout:void 0,velocities:[],allowMomentumBounce:void 0,isTouchEvent:void 0,startMoving:void 0},allowClick:!0,allowTouchMove:o.params.allowTouchMove,touches:{startX:0,startY:0,currentX:0,currentY:0,diff:0},imagesToLoad:[],imagesLoaded:0}),o.useModules(),o.params.init&&o.init(),o}}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={extendedDefaults:{configurable:!0},defaults:{configurable:!0},Class:{configurable:!0},$:{configurable:!0}};return t.prototype.slidesPerViewDynamic=function(){var e=this.params,t=this.slides,a=this.slidesGrid,r=this.size,n=this.activeIndex,i=1;if(e.centeredSlides){for(var s,o=t[n].swiperSlideSize,l=n+1;l<t.length;l+=1)t[l]&&!s&&(i+=1,(o+=t[l].swiperSlideSize)>r&&(s=!0));for(var p=n-1;p>=0;p-=1)t[p]&&!s&&(i+=1,(o+=t[p].swiperSlideSize)>r&&(s=!0))}else for(var c=n+1;c<t.length;c+=1)a[c]-a[n]<r&&(i+=1);return i},t.prototype.update=function(){var e=this;if(e&&!e.destroyed){var t=e.snapGrid,a=e.params;a.breakpoints&&e.setBreakpoint(),e.updateSize(),e.updateSlides(),e.updateProgress(),e.updateSlidesClasses(),e.params.freeMode?(r(),e.params.autoHeight&&e.updateAutoHeight()):(("auto"===e.params.slidesPerView||e.params.slidesPerView>1)&&e.isEnd&&!e.params.centeredSlides?e.slideTo(e.slides.length-1,0,!1,!0):e.slideTo(e.activeIndex,0,!1,!0))||r(),a.watchOverflow&&t!==e.snapGrid&&e.checkOverflow(),e.emit("update")}function r(){var t=e.rtlTranslate?-1*e.translate:e.translate,a=Math.min(Math.max(t,e.maxTranslate()),e.minTranslate());e.setTranslate(a),e.updateActiveIndex(),e.updateSlidesClasses()}},t.prototype.changeDirection=function(e,t){void 0===t&&(t=!0);var a=this.params.direction;return e||(e="horizontal"===a?"vertical":"horizontal"),e===a||"horizontal"!==e&&"vertical"!==e?this:("vertical"===a&&(this.$el.removeClass(this.params.containerModifierClass+"vertical wp8-vertical").addClass(""+this.params.containerModifierClass+e),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&this.$el.addClass(this.params.containerModifierClass+"wp8-"+e)),"horizontal"===a&&(this.$el.removeClass(this.params.containerModifierClass+"horizontal wp8-horizontal").addClass(""+this.params.containerModifierClass+e),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&this.$el.addClass(this.params.containerModifierClass+"wp8-"+e)),this.params.direction=e,this.slides.each(function(t,a){"vertical"===e?a.style.width="":a.style.height=""}),this.emit("changeDirection"),t&&this.update(),this)},t.prototype.init=function(){this.initialized||(this.emit("beforeInit"),this.params.breakpoints&&this.setBreakpoint(),this.addClasses(),this.params.loop&&this.loopCreate(),this.updateSize(),this.updateSlides(),this.params.watchOverflow&&this.checkOverflow(),this.params.grabCursor&&this.setGrabCursor(),this.params.preloadImages&&this.preloadImages(),this.params.loop?this.slideTo(this.params.initialSlide+this.loopedSlides,0,this.params.runCallbacksOnInit):this.slideTo(this.params.initialSlide,0,this.params.runCallbacksOnInit),this.attachEvents(),this.initialized=!0,this.emit("init"))},t.prototype.destroy=function(e,t){void 0===e&&(e=!0),void 0===t&&(t=!0);var a=this,r=a.params,n=a.$el,i=a.$wrapperEl,s=a.slides;return void 0===a.params||a.destroyed?null:(a.emit("beforeDestroy"),a.initialized=!1,a.detachEvents(),r.loop&&a.loopDestroy(),t&&(a.removeClasses(),n.removeAttr("style"),i.removeAttr("style"),s&&s.length&&s.removeClass([r.slideVisibleClass,r.slideActiveClass,r.slideNextClass,r.slidePrevClass].join(" ")).removeAttr("style").removeAttr("data-swiper-slide-index").removeAttr("data-swiper-column").removeAttr("data-swiper-row")),a.emit("destroy"),Object.keys(a.eventsListeners).forEach(function(e){a.off(e)}),!1!==e&&(a.$el[0].swiper=null,a.$el.data("swiper",null),Utils.deleteProps(a)),a.destroyed=!0,null)},t.extendDefaults=function(e){Utils.extend(extendedDefaults,e)},a.extendedDefaults.get=function(){return extendedDefaults},a.defaults.get=function(){return defaults},a.Class.get=function(){return e},a.$.get=function(){return $},Object.defineProperties(t,a),t}(Framework7Class),Device$1={name:"device",proto:{device:Device},static:{device:Device}},Support$1={name:"support",proto:{support:Support},static:{support:Support}},Browser$1={name:"browser",proto:{browser:Browser},static:{browser:Browser}},Resize={name:"resize",create:function(){var e=this;Utils.extend(e,{resize:{resizeHandler:function(){e&&!e.destroyed&&e.initialized&&(e.emit("beforeResize"),e.emit("resize"))},orientationChangeHandler:function(){e&&!e.destroyed&&e.initialized&&e.emit("orientationchange")}}})},on:{init:function(){win.addEventListener("resize",this.resize.resizeHandler),win.addEventListener("orientationchange",this.resize.orientationChangeHandler)},destroy:function(){win.removeEventListener("resize",this.resize.resizeHandler),win.removeEventListener("orientationchange",this.resize.orientationChangeHandler)}}},Observer={func:win.MutationObserver||win.WebkitMutationObserver,attach:function(e,t){void 0===t&&(t={});var a=this,r=new(0,Observer.func)(function(e){if(1!==e.length){var t=function(){a.emit("observerUpdate",e[0])};win.requestAnimationFrame?win.requestAnimationFrame(t):win.setTimeout(t,0)}else a.emit("observerUpdate",e[0])});r.observe(e,{attributes:void 0===t.attributes||t.attributes,childList:void 0===t.childList||t.childList,characterData:void 0===t.characterData||t.characterData}),a.observer.observers.push(r)},init:function(){if(Support.observer&&this.params.observer){if(this.params.observeParents)for(var e=this.$el.parents(),t=0;t<e.length;t+=1)this.observer.attach(e[t]);this.observer.attach(this.$el[0],{childList:this.params.observeSlideChildren}),this.observer.attach(this.$wrapperEl[0],{attributes:!1})}},destroy:function(){this.observer.observers.forEach(function(e){e.disconnect()}),this.observer.observers=[]}},Observer$1={name:"observer",params:{observer:!1,observeParents:!1,observeSlideChildren:!1},create:function(){Utils.extend(this,{observer:{init:Observer.init.bind(this),attach:Observer.attach.bind(this),destroy:Observer.destroy.bind(this),observers:[]}})},on:{init:function(){this.observer.init()},destroy:function(){this.observer.destroy()}}},Virtual={update:function(e){var t=this,a=t.params,r=a.slidesPerView,n=a.slidesPerGroup,i=a.centeredSlides,s=t.params.virtual,o=s.addSlidesBefore,l=s.addSlidesAfter,p=t.virtual,c=p.from,d=p.to,u=p.slides,h=p.slidesGrid,f=p.renderSlide,v=p.offset;t.updateActiveIndex();var m,g,b,y=t.activeIndex||0;m=t.rtlTranslate?"right":t.isHorizontal()?"left":"top",i?(g=Math.floor(r/2)+n+o,b=Math.floor(r/2)+n+l):(g=r+(n-1)+o,b=n+l);var w=Math.max((y||0)-b,0),C=Math.min((y||0)+g,u.length-1),x=(t.slidesGrid[w]||0)-(t.slidesGrid[0]||0);function $(){t.updateSlides(),t.updateProgress(),t.updateSlidesClasses(),t.lazy&&t.params.lazy.enabled&&t.lazy.load()}if(Utils.extend(t.virtual,{from:w,to:C,offset:x,slidesGrid:t.slidesGrid}),c===w&&d===C&&!e)return t.slidesGrid!==h&&x!==v&&t.slides.css(m,x+"px"),void t.updateProgress();if(t.params.virtual.renderExternal)return t.params.virtual.renderExternal.call(t,{offset:x,from:w,to:C,slides:function(){for(var e=[],t=w;t<=C;t+=1)e.push(u[t]);return e}()}),void $();var E=[],k=[];if(e)t.$wrapperEl.find("."+t.params.slideClass).remove();else for(var S=c;S<=d;S+=1)(S<w||S>C)&&t.$wrapperEl.find("."+t.params.slideClass+'[data-swiper-slide-index="'+S+'"]').remove();for(var T=0;T<u.length;T+=1)T>=w&&T<=C&&(void 0===d||e?k.push(T):(T>d&&k.push(T),T<c&&E.push(T)));k.forEach(function(e){t.$wrapperEl.append(f(u[e],e))}),E.sort(function(e,t){return t-e}).forEach(function(e){t.$wrapperEl.prepend(f(u[e],e))}),t.$wrapperEl.children(".swiper-slide").css(m,x+"px"),$()},renderSlide:function(e,t){var a=this.params.virtual;if(a.cache&&this.virtual.cache[t])return this.virtual.cache[t];var r=a.renderSlide?$(a.renderSlide.call(this,e,t)):$('<div class="'+this.params.slideClass+'" data-swiper-slide-index="'+t+'">'+e+"</div>");return r.attr("data-swiper-slide-index")||r.attr("data-swiper-slide-index",t),a.cache&&(this.virtual.cache[t]=r),r},appendSlide:function(e){if("object"==typeof e&&"length"in e)for(var t=0;t<e.length;t+=1)e[t]&&this.virtual.slides.push(e[t]);else this.virtual.slides.push(e);this.virtual.update(!0)},prependSlide:function(e){var t=this.activeIndex,a=t+1,r=1;if(Array.isArray(e)){for(var n=0;n<e.length;n+=1)e[n]&&this.virtual.slides.unshift(e[n]);a=t+e.length,r=e.length}else this.virtual.slides.unshift(e);if(this.params.virtual.cache){var i=this.virtual.cache,s={};Object.keys(i).forEach(function(e){s[parseInt(e,10)+r]=i[e]}),this.virtual.cache=s}this.virtual.update(!0),this.slideTo(a,0)},removeSlide:function(e){if(null!=e){var t=this.activeIndex;if(Array.isArray(e))for(var a=e.length-1;a>=0;a-=1)this.virtual.slides.splice(e[a],1),this.params.virtual.cache&&delete this.virtual.cache[e[a]],e[a]<t&&(t-=1),t=Math.max(t,0);else this.virtual.slides.splice(e,1),this.params.virtual.cache&&delete this.virtual.cache[e],e<t&&(t-=1),t=Math.max(t,0);this.virtual.update(!0),this.slideTo(t,0)}},removeAllSlides:function(){this.virtual.slides=[],this.params.virtual.cache&&(this.virtual.cache={}),this.virtual.update(!0),this.slideTo(0,0)}},Virtual$1={name:"virtual",params:{virtual:{enabled:!1,slides:[],cache:!0,renderSlide:null,renderExternal:null,addSlidesBefore:0,addSlidesAfter:0}},create:function(){Utils.extend(this,{virtual:{update:Virtual.update.bind(this),appendSlide:Virtual.appendSlide.bind(this),prependSlide:Virtual.prependSlide.bind(this),removeSlide:Virtual.removeSlide.bind(this),removeAllSlides:Virtual.removeAllSlides.bind(this),renderSlide:Virtual.renderSlide.bind(this),slides:this.params.virtual.slides,cache:{}}})},on:{beforeInit:function(){if(this.params.virtual.enabled){this.classNames.push(this.params.containerModifierClass+"virtual");var e={watchSlidesProgress:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e),this.params.initialSlide||this.virtual.update()}},setTranslate:function(){this.params.virtual.enabled&&this.virtual.update()}}},Navigation={update:function(){var e=this.params.navigation;if(!this.params.loop){var t=this.navigation,a=t.$nextEl,r=t.$prevEl;r&&r.length>0&&(this.isBeginning?r.addClass(e.disabledClass):r.removeClass(e.disabledClass),r[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](e.lockClass)),a&&a.length>0&&(this.isEnd?a.addClass(e.disabledClass):a.removeClass(e.disabledClass),a[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](e.lockClass))}},onPrevClick:function(e){e.preventDefault(),this.isBeginning&&!this.params.loop||this.slidePrev()},onNextClick:function(e){e.preventDefault(),this.isEnd&&!this.params.loop||this.slideNext()},init:function(){var e,t,a=this.params.navigation;(a.nextEl||a.prevEl)&&(a.nextEl&&(e=$(a.nextEl),this.params.uniqueNavElements&&"string"==typeof a.nextEl&&e.length>1&&1===this.$el.find(a.nextEl).length&&(e=this.$el.find(a.nextEl))),a.prevEl&&(t=$(a.prevEl),this.params.uniqueNavElements&&"string"==typeof a.prevEl&&t.length>1&&1===this.$el.find(a.prevEl).length&&(t=this.$el.find(a.prevEl))),e&&e.length>0&&e.on("click",this.navigation.onNextClick),t&&t.length>0&&t.on("click",this.navigation.onPrevClick),Utils.extend(this.navigation,{$nextEl:e,nextEl:e&&e[0],$prevEl:t,prevEl:t&&t[0]}))},destroy:function(){var e=this.navigation,t=e.$nextEl,a=e.$prevEl;t&&t.length&&(t.off("click",this.navigation.onNextClick),t.removeClass(this.params.navigation.disabledClass)),a&&a.length&&(a.off("click",this.navigation.onPrevClick),a.removeClass(this.params.navigation.disabledClass))}},Navigation$1={name:"navigation",params:{navigation:{nextEl:null,prevEl:null,hideOnClick:!1,disabledClass:"swiper-button-disabled",hiddenClass:"swiper-button-hidden",lockClass:"swiper-button-lock"}},create:function(){Utils.extend(this,{navigation:{init:Navigation.init.bind(this),update:Navigation.update.bind(this),destroy:Navigation.destroy.bind(this),onNextClick:Navigation.onNextClick.bind(this),onPrevClick:Navigation.onPrevClick.bind(this)}})},on:{init:function(){this.navigation.init(),this.navigation.update()},toEdge:function(){this.navigation.update()},fromEdge:function(){this.navigation.update()},destroy:function(){this.navigation.destroy()},click:function(e){var t,a=this.navigation,r=a.$nextEl,n=a.$prevEl;!this.params.navigation.hideOnClick||$(e.target).is(n)||$(e.target).is(r)||(r?t=r.hasClass(this.params.navigation.hiddenClass):n&&(t=n.hasClass(this.params.navigation.hiddenClass)),!0===t?this.emit("navigationShow",this):this.emit("navigationHide",this),r&&r.toggleClass(this.params.navigation.hiddenClass),n&&n.toggleClass(this.params.navigation.hiddenClass))}}},Pagination={update:function(){var e=this.rtl,t=this.params.pagination;if(t.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var a,r=this.virtual&&this.params.virtual.enabled?this.virtual.slides.length:this.slides.length,n=this.pagination.$el,i=this.params.loop?Math.ceil((r-2*this.loopedSlides)/this.params.slidesPerGroup):this.snapGrid.length;if(this.params.loop?((a=Math.ceil((this.activeIndex-this.loopedSlides)/this.params.slidesPerGroup))>r-1-2*this.loopedSlides&&(a-=r-2*this.loopedSlides),a>i-1&&(a-=i),a<0&&"bullets"!==this.params.paginationType&&(a=i+a)):a=void 0!==this.snapIndex?this.snapIndex:this.activeIndex||0,"bullets"===t.type&&this.pagination.bullets&&this.pagination.bullets.length>0){var s,o,l,p=this.pagination.bullets;if(t.dynamicBullets&&(this.pagination.bulletSize=p.eq(0)[this.isHorizontal()?"outerWidth":"outerHeight"](!0),n.css(this.isHorizontal()?"width":"height",this.pagination.bulletSize*(t.dynamicMainBullets+4)+"px"),t.dynamicMainBullets>1&&void 0!==this.previousIndex&&(this.pagination.dynamicBulletIndex+=a-this.previousIndex,this.pagination.dynamicBulletIndex>t.dynamicMainBullets-1?this.pagination.dynamicBulletIndex=t.dynamicMainBullets-1:this.pagination.dynamicBulletIndex<0&&(this.pagination.dynamicBulletIndex=0)),s=a-this.pagination.dynamicBulletIndex,l=((o=s+(Math.min(p.length,t.dynamicMainBullets)-1))+s)/2),p.removeClass(t.bulletActiveClass+" "+t.bulletActiveClass+"-next "+t.bulletActiveClass+"-next-next "+t.bulletActiveClass+"-prev "+t.bulletActiveClass+"-prev-prev "+t.bulletActiveClass+"-main"),n.length>1)p.each(function(e,r){var n=$(r),i=n.index();i===a&&n.addClass(t.bulletActiveClass),t.dynamicBullets&&(i>=s&&i<=o&&n.addClass(t.bulletActiveClass+"-main"),i===s&&n.prev().addClass(t.bulletActiveClass+"-prev").prev().addClass(t.bulletActiveClass+"-prev-prev"),i===o&&n.next().addClass(t.bulletActiveClass+"-next").next().addClass(t.bulletActiveClass+"-next-next"))});else if(p.eq(a).addClass(t.bulletActiveClass),t.dynamicBullets){for(var c=p.eq(s),d=p.eq(o),u=s;u<=o;u+=1)p.eq(u).addClass(t.bulletActiveClass+"-main");c.prev().addClass(t.bulletActiveClass+"-prev").prev().addClass(t.bulletActiveClass+"-prev-prev"),d.next().addClass(t.bulletActiveClass+"-next").next().addClass(t.bulletActiveClass+"-next-next")}if(t.dynamicBullets){var h=Math.min(p.length,t.dynamicMainBullets+4),f=(this.pagination.bulletSize*h-this.pagination.bulletSize)/2-l*this.pagination.bulletSize,v=e?"right":"left";p.css(this.isHorizontal()?v:"top",f+"px")}}if("fraction"===t.type&&(n.find("."+t.currentClass).text(t.formatFractionCurrent(a+1)),n.find("."+t.totalClass).text(t.formatFractionTotal(i))),"progressbar"===t.type){var m;m=t.progressbarOpposite?this.isHorizontal()?"vertical":"horizontal":this.isHorizontal()?"horizontal":"vertical";var g=(a+1)/i,b=1,y=1;"horizontal"===m?b=g:y=g,n.find("."+t.progressbarFillClass).transform("translate3d(0,0,0) scaleX("+b+") scaleY("+y+")").transition(this.params.speed)}"custom"===t.type&&t.renderCustom?(n.html(t.renderCustom(this,a+1,i)),this.emit("paginationRender",this,n[0])):this.emit("paginationUpdate",this,n[0]),n[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](t.lockClass)}},render:function(){var e=this.params.pagination;if(e.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var t=this.virtual&&this.params.virtual.enabled?this.virtual.slides.length:this.slides.length,a=this.pagination.$el,r="";if("bullets"===e.type){for(var n=this.params.loop?Math.ceil((t-2*this.loopedSlides)/this.params.slidesPerGroup):this.snapGrid.length,i=0;i<n;i+=1)e.renderBullet?r+=e.renderBullet.call(this,i,e.bulletClass):r+="<"+e.bulletElement+' class="'+e.bulletClass+'"></'+e.bulletElement+">";a.html(r),this.pagination.bullets=a.find("."+e.bulletClass)}"fraction"===e.type&&(r=e.renderFraction?e.renderFraction.call(this,e.currentClass,e.totalClass):'<span class="'+e.currentClass+'"></span> / <span class="'+e.totalClass+'"></span>',a.html(r)),"progressbar"===e.type&&(r=e.renderProgressbar?e.renderProgressbar.call(this,e.progressbarFillClass):'<span class="'+e.progressbarFillClass+'"></span>',a.html(r)),"custom"!==e.type&&this.emit("paginationRender",this.pagination.$el[0])}},init:function(){var e=this,t=e.params.pagination;if(t.el){var a=$(t.el);0!==a.length&&(e.params.uniqueNavElements&&"string"==typeof t.el&&a.length>1&&1===e.$el.find(t.el).length&&(a=e.$el.find(t.el)),"bullets"===t.type&&t.clickable&&a.addClass(t.clickableClass),a.addClass(t.modifierClass+t.type),"bullets"===t.type&&t.dynamicBullets&&(a.addClass(""+t.modifierClass+t.type+"-dynamic"),e.pagination.dynamicBulletIndex=0,t.dynamicMainBullets<1&&(t.dynamicMainBullets=1)),"progressbar"===t.type&&t.progressbarOpposite&&a.addClass(t.progressbarOppositeClass),t.clickable&&a.on("click","."+t.bulletClass,function(t){t.preventDefault();var a=$(this).index()*e.params.slidesPerGroup;e.params.loop&&(a+=e.loopedSlides),e.slideTo(a)}),Utils.extend(e.pagination,{$el:a,el:a[0]}))}},destroy:function(){var e=this.params.pagination;if(e.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var t=this.pagination.$el;t.removeClass(e.hiddenClass),t.removeClass(e.modifierClass+e.type),this.pagination.bullets&&this.pagination.bullets.removeClass(e.bulletActiveClass),e.clickable&&t.off("click","."+e.bulletClass)}}},Pagination$1={name:"pagination",params:{pagination:{el:null,bulletElement:"span",clickable:!1,hideOnClick:!1,renderBullet:null,renderProgressbar:null,renderFraction:null,renderCustom:null,progressbarOpposite:!1,type:"bullets",dynamicBullets:!1,dynamicMainBullets:1,formatFractionCurrent:function(e){return e},formatFractionTotal:function(e){return e},bulletClass:"swiper-pagination-bullet",bulletActiveClass:"swiper-pagination-bullet-active",modifierClass:"swiper-pagination-",currentClass:"swiper-pagination-current",totalClass:"swiper-pagination-total",hiddenClass:"swiper-pagination-hidden",progressbarFillClass:"swiper-pagination-progressbar-fill",progressbarOppositeClass:"swiper-pagination-progressbar-opposite",clickableClass:"swiper-pagination-clickable",lockClass:"swiper-pagination-lock"}},create:function(){Utils.extend(this,{pagination:{init:Pagination.init.bind(this),render:Pagination.render.bind(this),update:Pagination.update.bind(this),destroy:Pagination.destroy.bind(this),dynamicBulletIndex:0}})},on:{init:function(){this.pagination.init(),this.pagination.render(),this.pagination.update()},activeIndexChange:function(){this.params.loop?this.pagination.update():void 0===this.snapIndex&&this.pagination.update()},snapIndexChange:function(){this.params.loop||this.pagination.update()},slidesLengthChange:function(){this.params.loop&&(this.pagination.render(),this.pagination.update())},snapGridLengthChange:function(){this.params.loop||(this.pagination.render(),this.pagination.update())},destroy:function(){this.pagination.destroy()},click:function(e){this.params.pagination.el&&this.params.pagination.hideOnClick&&this.pagination.$el.length>0&&!$(e.target).hasClass(this.params.pagination.bulletClass)&&(!0===this.pagination.$el.hasClass(this.params.pagination.hiddenClass)?this.emit("paginationShow",this):this.emit("paginationHide",this),this.pagination.$el.toggleClass(this.params.pagination.hiddenClass))}}},Scrollbar={setTranslate:function(){if(this.params.scrollbar.el&&this.scrollbar.el){var e=this.scrollbar,t=this.rtlTranslate,a=this.progress,r=e.dragSize,n=e.trackSize,i=e.$dragEl,s=e.$el,o=this.params.scrollbar,l=r,p=(n-r)*a;t?(p=-p)>0?(l=r-p,p=0):-p+r>n&&(l=n+p):p<0?(l=r+p,p=0):p+r>n&&(l=n-p),this.isHorizontal()?(Support.transforms3d?i.transform("translate3d("+p+"px, 0, 0)"):i.transform("translateX("+p+"px)"),i[0].style.width=l+"px"):(Support.transforms3d?i.transform("translate3d(0px, "+p+"px, 0)"):i.transform("translateY("+p+"px)"),i[0].style.height=l+"px"),o.hide&&(clearTimeout(this.scrollbar.timeout),s[0].style.opacity=1,this.scrollbar.timeout=setTimeout(function(){s[0].style.opacity=0,s.transition(400)},1e3))}},setTransition:function(e){this.params.scrollbar.el&&this.scrollbar.el&&this.scrollbar.$dragEl.transition(e)},updateSize:function(){if(this.params.scrollbar.el&&this.scrollbar.el){var e=this.scrollbar,t=e.$dragEl,a=e.$el;t[0].style.width="",t[0].style.height="";var r,n=this.isHorizontal()?a[0].offsetWidth:a[0].offsetHeight,i=this.size/this.virtualSize,s=i*(n/this.size);r="auto"===this.params.scrollbar.dragSize?n*i:parseInt(this.params.scrollbar.dragSize,10),this.isHorizontal()?t[0].style.width=r+"px":t[0].style.height=r+"px",a[0].style.display=i>=1?"none":"",this.params.scrollbar.hide&&(a[0].style.opacity=0),Utils.extend(e,{trackSize:n,divider:i,moveDivider:s,dragSize:r}),e.$el[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](this.params.scrollbar.lockClass)}},setDragPosition:function(e){var t,a=this.scrollbar,r=this.rtlTranslate,n=a.$el,i=a.dragSize,s=a.trackSize;t=((this.isHorizontal()?"touchstart"===e.type||"touchmove"===e.type?e.targetTouches[0].pageX:e.pageX||e.clientX:"touchstart"===e.type||"touchmove"===e.type?e.targetTouches[0].pageY:e.pageY||e.clientY)-n.offset()[this.isHorizontal()?"left":"top"]-i/2)/(s-i),t=Math.max(Math.min(t,1),0),r&&(t=1-t);var o=this.minTranslate()+(this.maxTranslate()-this.minTranslate())*t;this.updateProgress(o),this.setTranslate(o),this.updateActiveIndex(),this.updateSlidesClasses()},onDragStart:function(e){var t=this.params.scrollbar,a=this.scrollbar,r=this.$wrapperEl,n=a.$el,i=a.$dragEl;this.scrollbar.isTouched=!0,e.preventDefault(),e.stopPropagation(),r.transition(100),i.transition(100),a.setDragPosition(e),clearTimeout(this.scrollbar.dragTimeout),n.transition(0),t.hide&&n.css("opacity",1),this.emit("scrollbarDragStart",e)},onDragMove:function(e){var t=this.scrollbar,a=this.$wrapperEl,r=t.$el,n=t.$dragEl;this.scrollbar.isTouched&&(e.preventDefault?e.preventDefault():e.returnValue=!1,t.setDragPosition(e),a.transition(0),r.transition(0),n.transition(0),this.emit("scrollbarDragMove",e))},onDragEnd:function(e){var t=this.params.scrollbar,a=this.scrollbar.$el;this.scrollbar.isTouched&&(this.scrollbar.isTouched=!1,t.hide&&(clearTimeout(this.scrollbar.dragTimeout),this.scrollbar.dragTimeout=Utils.nextTick(function(){a.css("opacity",0),a.transition(400)},1e3)),this.emit("scrollbarDragEnd",e),t.snapOnRelease&&this.slideToClosest())},enableDraggable:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.touchEventsTouch,a=this.touchEventsDesktop,r=this.params,n=e.$el[0],i=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!1,capture:!1},s=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!0,capture:!1};Support.touch?(n.addEventListener(t.start,this.scrollbar.onDragStart,i),n.addEventListener(t.move,this.scrollbar.onDragMove,i),n.addEventListener(t.end,this.scrollbar.onDragEnd,s)):(n.addEventListener(a.start,this.scrollbar.onDragStart,i),doc.addEventListener(a.move,this.scrollbar.onDragMove,i),doc.addEventListener(a.end,this.scrollbar.onDragEnd,s))}},disableDraggable:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.touchEventsTouch,a=this.touchEventsDesktop,r=this.params,n=e.$el[0],i=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!1,capture:!1},s=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!0,capture:!1};Support.touch?(n.removeEventListener(t.start,this.scrollbar.onDragStart,i),n.removeEventListener(t.move,this.scrollbar.onDragMove,i),n.removeEventListener(t.end,this.scrollbar.onDragEnd,s)):(n.removeEventListener(a.start,this.scrollbar.onDragStart,i),doc.removeEventListener(a.move,this.scrollbar.onDragMove,i),doc.removeEventListener(a.end,this.scrollbar.onDragEnd,s))}},init:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.$el,a=this.params.scrollbar,r=$(a.el);this.params.uniqueNavElements&&"string"==typeof a.el&&r.length>1&&1===t.find(a.el).length&&(r=t.find(a.el));var n=r.find("."+this.params.scrollbar.dragClass);0===n.length&&(n=$('<div class="'+this.params.scrollbar.dragClass+'"></div>'),r.append(n)),Utils.extend(e,{$el:r,el:r[0],$dragEl:n,dragEl:n[0]}),a.draggable&&e.enableDraggable()}},destroy:function(){this.scrollbar.disableDraggable()}},Scrollbar$1={name:"scrollbar",params:{scrollbar:{el:null,dragSize:"auto",hide:!1,draggable:!1,snapOnRelease:!0,lockClass:"swiper-scrollbar-lock",dragClass:"swiper-scrollbar-drag"}},create:function(){Utils.extend(this,{scrollbar:{init:Scrollbar.init.bind(this),destroy:Scrollbar.destroy.bind(this),updateSize:Scrollbar.updateSize.bind(this),setTranslate:Scrollbar.setTranslate.bind(this),setTransition:Scrollbar.setTransition.bind(this),enableDraggable:Scrollbar.enableDraggable.bind(this),disableDraggable:Scrollbar.disableDraggable.bind(this),setDragPosition:Scrollbar.setDragPosition.bind(this),onDragStart:Scrollbar.onDragStart.bind(this),onDragMove:Scrollbar.onDragMove.bind(this),onDragEnd:Scrollbar.onDragEnd.bind(this),isTouched:!1,timeout:null,dragTimeout:null}})},on:{init:function(){this.scrollbar.init(),this.scrollbar.updateSize(),this.scrollbar.setTranslate()},update:function(){this.scrollbar.updateSize()},resize:function(){this.scrollbar.updateSize()},observerUpdate:function(){this.scrollbar.updateSize()},setTranslate:function(){this.scrollbar.setTranslate()},setTransition:function(e){this.scrollbar.setTransition(e)},destroy:function(){this.scrollbar.destroy()}}},Parallax={setTransform:function(e,t){var a=this.rtl,r=$(e),n=a?-1:1,i=r.attr("data-swiper-parallax")||"0",s=r.attr("data-swiper-parallax-x"),o=r.attr("data-swiper-parallax-y"),l=r.attr("data-swiper-parallax-scale"),p=r.attr("data-swiper-parallax-opacity");if(s||o?(s=s||"0",o=o||"0"):this.isHorizontal()?(s=i,o="0"):(o=i,s="0"),s=s.indexOf("%")>=0?parseInt(s,10)*t*n+"%":s*t*n+"px",o=o.indexOf("%")>=0?parseInt(o,10)*t+"%":o*t+"px",null!=p){var c=p-(p-1)*(1-Math.abs(t));r[0].style.opacity=c}if(null==l)r.transform("translate3d("+s+", "+o+", 0px)");else{var d=l-(l-1)*(1-Math.abs(t));r.transform("translate3d("+s+", "+o+", 0px) scale("+d+")")}},setTranslate:function(){var e=this,t=e.$el,a=e.slides,r=e.progress,n=e.snapGrid;t.children("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){e.parallax.setTransform(a,r)}),a.each(function(t,a){var i=a.progress;e.params.slidesPerGroup>1&&"auto"!==e.params.slidesPerView&&(i+=Math.ceil(t/2)-r*(n.length-1)),i=Math.min(Math.max(i,-1),1),$(a).find("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){e.parallax.setTransform(a,i)})})},setTransition:function(e){void 0===e&&(e=this.params.speed);this.$el.find("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){var r=$(a),n=parseInt(r.attr("data-swiper-parallax-duration"),10)||e;0===e&&(n=0),r.transition(n)})}},Parallax$1={name:"parallax",params:{parallax:{enabled:!1}},create:function(){Utils.extend(this,{parallax:{setTransform:Parallax.setTransform.bind(this),setTranslate:Parallax.setTranslate.bind(this),setTransition:Parallax.setTransition.bind(this)}})},on:{beforeInit:function(){this.params.parallax.enabled&&(this.params.watchSlidesProgress=!0,this.originalParams.watchSlidesProgress=!0)},init:function(){this.params.parallax.enabled&&this.parallax.setTranslate()},setTranslate:function(){this.params.parallax.enabled&&this.parallax.setTranslate()},setTransition:function(e){this.params.parallax.enabled&&this.parallax.setTransition(e)}}},Zoom={getDistanceBetweenTouches:function(e){if(e.targetTouches.length<2)return 1;var t=e.targetTouches[0].pageX,a=e.targetTouches[0].pageY,r=e.targetTouches[1].pageX,n=e.targetTouches[1].pageY;return Math.sqrt(Math.pow(r-t,2)+Math.pow(n-a,2))},onGestureStart:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(a.fakeGestureTouched=!1,a.fakeGestureMoved=!1,!Support.gestures){if("touchstart"!==e.type||"touchstart"===e.type&&e.targetTouches.length<2)return;a.fakeGestureTouched=!0,r.scaleStart=Zoom.getDistanceBetweenTouches(e)}r.$slideEl&&r.$slideEl.length||(r.$slideEl=$(e.target).closest(".swiper-slide"),0===r.$slideEl.length&&(r.$slideEl=this.slides.eq(this.activeIndex)),r.$imageEl=r.$slideEl.find("img, svg, canvas"),r.$imageWrapEl=r.$imageEl.parent("."+t.containerClass),r.maxRatio=r.$imageWrapEl.attr("data-swiper-zoom")||t.maxRatio,0!==r.$imageWrapEl.length)?(r.$imageEl.transition(0),this.zoom.isScaling=!0):r.$imageEl=void 0},onGestureChange:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(!Support.gestures){if("touchmove"!==e.type||"touchmove"===e.type&&e.targetTouches.length<2)return;a.fakeGestureMoved=!0,r.scaleMove=Zoom.getDistanceBetweenTouches(e)}r.$imageEl&&0!==r.$imageEl.length&&(Support.gestures?a.scale=e.scale*a.currentScale:a.scale=r.scaleMove/r.scaleStart*a.currentScale,a.scale>r.maxRatio&&(a.scale=r.maxRatio-1+Math.pow(a.scale-r.maxRatio+1,.5)),a.scale<t.minRatio&&(a.scale=t.minRatio+1-Math.pow(t.minRatio-a.scale+1,.5)),r.$imageEl.transform("translate3d(0,0,0) scale("+a.scale+")"))},onGestureEnd:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(!Support.gestures){if(!a.fakeGestureTouched||!a.fakeGestureMoved)return;if("touchend"!==e.type||"touchend"===e.type&&e.changedTouches.length<2&&!Device.android)return;a.fakeGestureTouched=!1,a.fakeGestureMoved=!1}r.$imageEl&&0!==r.$imageEl.length&&(a.scale=Math.max(Math.min(a.scale,r.maxRatio),t.minRatio),r.$imageEl.transition(this.params.speed).transform("translate3d(0,0,0) scale("+a.scale+")"),a.currentScale=a.scale,a.isScaling=!1,1===a.scale&&(r.$slideEl=void 0))},onTouchStart:function(e){var t=this.zoom,a=t.gesture,r=t.image;a.$imageEl&&0!==a.$imageEl.length&&(r.isTouched||(Device.android&&e.preventDefault(),r.isTouched=!0,r.touchesStart.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,r.touchesStart.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY))},onTouchMove:function(e){var t=this.zoom,a=t.gesture,r=t.image,n=t.velocity;if(a.$imageEl&&0!==a.$imageEl.length&&(this.allowClick=!1,r.isTouched&&a.$slideEl)){r.isMoved||(r.width=a.$imageEl[0].offsetWidth,r.height=a.$imageEl[0].offsetHeight,r.startX=Utils.getTranslate(a.$imageWrapEl[0],"x")||0,r.startY=Utils.getTranslate(a.$imageWrapEl[0],"y")||0,a.slideWidth=a.$slideEl[0].offsetWidth,a.slideHeight=a.$slideEl[0].offsetHeight,a.$imageWrapEl.transition(0),this.rtl&&(r.startX=-r.startX,r.startY=-r.startY));var i=r.width*t.scale,s=r.height*t.scale;if(!(i<a.slideWidth&&s<a.slideHeight)){if(r.minX=Math.min(a.slideWidth/2-i/2,0),r.maxX=-r.minX,r.minY=Math.min(a.slideHeight/2-s/2,0),r.maxY=-r.minY,r.touchesCurrent.x="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,r.touchesCurrent.y="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,!r.isMoved&&!t.isScaling){if(this.isHorizontal()&&(Math.floor(r.minX)===Math.floor(r.startX)&&r.touchesCurrent.x<r.touchesStart.x||Math.floor(r.maxX)===Math.floor(r.startX)&&r.touchesCurrent.x>r.touchesStart.x))return void(r.isTouched=!1);if(!this.isHorizontal()&&(Math.floor(r.minY)===Math.floor(r.startY)&&r.touchesCurrent.y<r.touchesStart.y||Math.floor(r.maxY)===Math.floor(r.startY)&&r.touchesCurrent.y>r.touchesStart.y))return void(r.isTouched=!1)}e.preventDefault(),e.stopPropagation(),r.isMoved=!0,r.currentX=r.touchesCurrent.x-r.touchesStart.x+r.startX,r.currentY=r.touchesCurrent.y-r.touchesStart.y+r.startY,r.currentX<r.minX&&(r.currentX=r.minX+1-Math.pow(r.minX-r.currentX+1,.8)),r.currentX>r.maxX&&(r.currentX=r.maxX-1+Math.pow(r.currentX-r.maxX+1,.8)),r.currentY<r.minY&&(r.currentY=r.minY+1-Math.pow(r.minY-r.currentY+1,.8)),r.currentY>r.maxY&&(r.currentY=r.maxY-1+Math.pow(r.currentY-r.maxY+1,.8)),n.prevPositionX||(n.prevPositionX=r.touchesCurrent.x),n.prevPositionY||(n.prevPositionY=r.touchesCurrent.y),n.prevTime||(n.prevTime=Date.now()),n.x=(r.touchesCurrent.x-n.prevPositionX)/(Date.now()-n.prevTime)/2,n.y=(r.touchesCurrent.y-n.prevPositionY)/(Date.now()-n.prevTime)/2,Math.abs(r.touchesCurrent.x-n.prevPositionX)<2&&(n.x=0),Math.abs(r.touchesCurrent.y-n.prevPositionY)<2&&(n.y=0),n.prevPositionX=r.touchesCurrent.x,n.prevPositionY=r.touchesCurrent.y,n.prevTime=Date.now(),a.$imageWrapEl.transform("translate3d("+r.currentX+"px, "+r.currentY+"px,0)")}}},onTouchEnd:function(){var e=this.zoom,t=e.gesture,a=e.image,r=e.velocity;if(t.$imageEl&&0!==t.$imageEl.length){if(!a.isTouched||!a.isMoved)return a.isTouched=!1,void(a.isMoved=!1);a.isTouched=!1,a.isMoved=!1;var n=300,i=300,s=r.x*n,o=a.currentX+s,l=r.y*i,p=a.currentY+l;0!==r.x&&(n=Math.abs((o-a.currentX)/r.x)),0!==r.y&&(i=Math.abs((p-a.currentY)/r.y));var c=Math.max(n,i);a.currentX=o,a.currentY=p;var d=a.width*e.scale,u=a.height*e.scale;a.minX=Math.min(t.slideWidth/2-d/2,0),a.maxX=-a.minX,a.minY=Math.min(t.slideHeight/2-u/2,0),a.maxY=-a.minY,a.currentX=Math.max(Math.min(a.currentX,a.maxX),a.minX),a.currentY=Math.max(Math.min(a.currentY,a.maxY),a.minY),t.$imageWrapEl.transition(c).transform("translate3d("+a.currentX+"px, "+a.currentY+"px,0)")}},onTransitionEnd:function(){var e=this.zoom,t=e.gesture;t.$slideEl&&this.previousIndex!==this.activeIndex&&(t.$imageEl.transform("translate3d(0,0,0) scale(1)"),t.$imageWrapEl.transform("translate3d(0,0,0)"),e.scale=1,e.currentScale=1,t.$slideEl=void 0,t.$imageEl=void 0,t.$imageWrapEl=void 0)},toggle:function(e){var t=this.zoom;t.scale&&1!==t.scale?t.out():t.in(e)},in:function(e){var t,a,r,n,i,s,o,l,p,c,d,u,h,f,v,m,g=this.zoom,b=this.params.zoom,y=g.gesture,w=g.image;(y.$slideEl||(y.$slideEl=this.clickedSlide?$(this.clickedSlide):this.slides.eq(this.activeIndex),y.$imageEl=y.$slideEl.find("img, svg, canvas"),y.$imageWrapEl=y.$imageEl.parent("."+b.containerClass)),y.$imageEl&&0!==y.$imageEl.length)&&(y.$slideEl.addClass(""+b.zoomedSlideClass),void 0===w.touchesStart.x&&e?(t="touchend"===e.type?e.changedTouches[0].pageX:e.pageX,a="touchend"===e.type?e.changedTouches[0].pageY:e.pageY):(t=w.touchesStart.x,a=w.touchesStart.y),g.scale=y.$imageWrapEl.attr("data-swiper-zoom")||b.maxRatio,g.currentScale=y.$imageWrapEl.attr("data-swiper-zoom")||b.maxRatio,e?(v=y.$slideEl[0].offsetWidth,m=y.$slideEl[0].offsetHeight,r=y.$slideEl.offset().left+v/2-t,n=y.$slideEl.offset().top+m/2-a,o=y.$imageEl[0].offsetWidth,l=y.$imageEl[0].offsetHeight,p=o*g.scale,c=l*g.scale,h=-(d=Math.min(v/2-p/2,0)),f=-(u=Math.min(m/2-c/2,0)),(i=r*g.scale)<d&&(i=d),i>h&&(i=h),(s=n*g.scale)<u&&(s=u),s>f&&(s=f)):(i=0,s=0),y.$imageWrapEl.transition(300).transform("translate3d("+i+"px, "+s+"px,0)"),y.$imageEl.transition(300).transform("translate3d(0,0,0) scale("+g.scale+")"))},out:function(){var e=this.zoom,t=this.params.zoom,a=e.gesture;a.$slideEl||(a.$slideEl=this.clickedSlide?$(this.clickedSlide):this.slides.eq(this.activeIndex),a.$imageEl=a.$slideEl.find("img, svg, canvas"),a.$imageWrapEl=a.$imageEl.parent("."+t.containerClass)),a.$imageEl&&0!==a.$imageEl.length&&(e.scale=1,e.currentScale=1,a.$imageWrapEl.transition(300).transform("translate3d(0,0,0)"),a.$imageEl.transition(300).transform("translate3d(0,0,0) scale(1)"),a.$slideEl.removeClass(""+t.zoomedSlideClass),a.$slideEl=void 0)},enable:function(){var e=this.zoom;if(!e.enabled){e.enabled=!0;var t=!("touchstart"!==this.touchEvents.start||!Support.passiveListener||!this.params.passiveListeners)&&{passive:!0,capture:!1};Support.gestures?(this.$wrapperEl.on("gesturestart",".swiper-slide",e.onGestureStart,t),this.$wrapperEl.on("gesturechange",".swiper-slide",e.onGestureChange,t),this.$wrapperEl.on("gestureend",".swiper-slide",e.onGestureEnd,t)):"touchstart"===this.touchEvents.start&&(this.$wrapperEl.on(this.touchEvents.start,".swiper-slide",e.onGestureStart,t),this.$wrapperEl.on(this.touchEvents.move,".swiper-slide",e.onGestureChange,t),this.$wrapperEl.on(this.touchEvents.end,".swiper-slide",e.onGestureEnd,t)),this.$wrapperEl.on(this.touchEvents.move,"."+this.params.zoom.containerClass,e.onTouchMove)}},disable:function(){var e=this.zoom;if(e.enabled){this.zoom.enabled=!1;var t=!("touchstart"!==this.touchEvents.start||!Support.passiveListener||!this.params.passiveListeners)&&{passive:!0,capture:!1};Support.gestures?(this.$wrapperEl.off("gesturestart",".swiper-slide",e.onGestureStart,t),this.$wrapperEl.off("gesturechange",".swiper-slide",e.onGestureChange,t),this.$wrapperEl.off("gestureend",".swiper-slide",e.onGestureEnd,t)):"touchstart"===this.touchEvents.start&&(this.$wrapperEl.off(this.touchEvents.start,".swiper-slide",e.onGestureStart,t),this.$wrapperEl.off(this.touchEvents.move,".swiper-slide",e.onGestureChange,t),this.$wrapperEl.off(this.touchEvents.end,".swiper-slide",e.onGestureEnd,t)),this.$wrapperEl.off(this.touchEvents.move,"."+this.params.zoom.containerClass,e.onTouchMove)}}},Zoom$1={name:"zoom",params:{zoom:{enabled:!1,maxRatio:3,minRatio:1,toggle:!0,containerClass:"swiper-zoom-container",zoomedSlideClass:"swiper-slide-zoomed"}},create:function(){var e=this,t={enabled:!1,scale:1,currentScale:1,isScaling:!1,gesture:{$slideEl:void 0,slideWidth:void 0,slideHeight:void 0,$imageEl:void 0,$imageWrapEl:void 0,maxRatio:3},image:{isTouched:void 0,isMoved:void 0,currentX:void 0,currentY:void 0,minX:void 0,minY:void 0,maxX:void 0,maxY:void 0,width:void 0,height:void 0,startX:void 0,startY:void 0,touchesStart:{},touchesCurrent:{}},velocity:{x:void 0,y:void 0,prevPositionX:void 0,prevPositionY:void 0,prevTime:void 0}};"onGestureStart onGestureChange onGestureEnd onTouchStart onTouchMove onTouchEnd onTransitionEnd toggle enable disable in out".split(" ").forEach(function(a){t[a]=Zoom[a].bind(e)}),Utils.extend(e,{zoom:t});var a=1;Object.defineProperty(e.zoom,"scale",{get:function(){return a},set:function(t){if(a!==t){var r=e.zoom.gesture.$imageEl?e.zoom.gesture.$imageEl[0]:void 0,n=e.zoom.gesture.$slideEl?e.zoom.gesture.$slideEl[0]:void 0;e.emit("zoomChange",t,r,n)}a=t}})},on:{init:function(){this.params.zoom.enabled&&this.zoom.enable()},destroy:function(){this.zoom.disable()},touchStart:function(e){this.zoom.enabled&&this.zoom.onTouchStart(e)},touchEnd:function(e){this.zoom.enabled&&this.zoom.onTouchEnd(e)},doubleTap:function(e){this.params.zoom.enabled&&this.zoom.enabled&&this.params.zoom.toggle&&this.zoom.toggle(e)},transitionEnd:function(){this.zoom.enabled&&this.params.zoom.enabled&&this.zoom.onTransitionEnd()}}},Lazy$2={loadInSlide:function(e,t){void 0===t&&(t=!0);var a=this,r=a.params.lazy;if(void 0!==e&&0!==a.slides.length){var n=a.virtual&&a.params.virtual.enabled?a.$wrapperEl.children("."+a.params.slideClass+'[data-swiper-slide-index="'+e+'"]'):a.slides.eq(e),i=n.find("."+r.elementClass+":not(."+r.loadedClass+"):not(."+r.loadingClass+")");!n.hasClass(r.elementClass)||n.hasClass(r.loadedClass)||n.hasClass(r.loadingClass)||(i=i.add(n[0])),0!==i.length&&i.each(function(e,i){var s=$(i);s.addClass(r.loadingClass);var o=s.attr("data-background"),l=s.attr("data-src"),p=s.attr("data-srcset"),c=s.attr("data-sizes");a.loadImage(s[0],l||o,p,c,!1,function(){if(null!=a&&a&&(!a||a.params)&&!a.destroyed){if(o?(s.css("background-image",'url("'+o+'")'),s.removeAttr("data-background")):(p&&(s.attr("srcset",p),s.removeAttr("data-srcset")),c&&(s.attr("sizes",c),s.removeAttr("data-sizes")),l&&(s.attr("src",l),s.removeAttr("data-src"))),s.addClass(r.loadedClass).removeClass(r.loadingClass),n.find("."+r.preloaderClass).remove(),a.params.loop&&t){var e=n.attr("data-swiper-slide-index");if(n.hasClass(a.params.slideDuplicateClass)){var i=a.$wrapperEl.children('[data-swiper-slide-index="'+e+'"]:not(.'+a.params.slideDuplicateClass+")");a.lazy.loadInSlide(i.index(),!1)}else{var d=a.$wrapperEl.children("."+a.params.slideDuplicateClass+'[data-swiper-slide-index="'+e+'"]');a.lazy.loadInSlide(d.index(),!1)}}a.emit("lazyImageReady",n[0],s[0])}}),a.emit("lazyImageLoad",n[0],s[0])})}},load:function(){var e=this,t=e.$wrapperEl,a=e.params,r=e.slides,n=e.activeIndex,i=e.virtual&&a.virtual.enabled,s=a.lazy,o=a.slidesPerView;function l(e){if(i){if(t.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]').length)return!0}else if(r[e])return!0;return!1}function p(e){return i?$(e).attr("data-swiper-slide-index"):$(e).index()}if("auto"===o&&(o=0),e.lazy.initialImageLoaded||(e.lazy.initialImageLoaded=!0),e.params.watchSlidesVisibility)t.children("."+a.slideVisibleClass).each(function(t,a){var r=i?$(a).attr("data-swiper-slide-index"):$(a).index();e.lazy.loadInSlide(r)});else if(o>1)for(var c=n;c<n+o;c+=1)l(c)&&e.lazy.loadInSlide(c);else e.lazy.loadInSlide(n);if(s.loadPrevNext)if(o>1||s.loadPrevNextAmount&&s.loadPrevNextAmount>1){for(var d=s.loadPrevNextAmount,u=o,h=Math.min(n+u+Math.max(d,u),r.length),f=Math.max(n-Math.max(u,d),0),v=n+o;v<h;v+=1)l(v)&&e.lazy.loadInSlide(v);for(var m=f;m<n;m+=1)l(m)&&e.lazy.loadInSlide(m)}else{var g=t.children("."+a.slideNextClass);g.length>0&&e.lazy.loadInSlide(p(g));var b=t.children("."+a.slidePrevClass);b.length>0&&e.lazy.loadInSlide(p(b))}}},Lazy$3={name:"lazy",params:{lazy:{enabled:!1,loadPrevNext:!1,loadPrevNextAmount:1,loadOnTransitionStart:!1,elementClass:"swiper-lazy",loadingClass:"swiper-lazy-loading",loadedClass:"swiper-lazy-loaded",preloaderClass:"swiper-lazy-preloader"}},create:function(){Utils.extend(this,{lazy:{initialImageLoaded:!1,load:Lazy$2.load.bind(this),loadInSlide:Lazy$2.loadInSlide.bind(this)}})},on:{beforeInit:function(){this.params.lazy.enabled&&this.params.preloadImages&&(this.params.preloadImages=!1)},init:function(){this.params.lazy.enabled&&!this.params.loop&&0===this.params.initialSlide&&this.lazy.load()},scroll:function(){this.params.freeMode&&!this.params.freeModeSticky&&this.lazy.load()},resize:function(){this.params.lazy.enabled&&this.lazy.load()},scrollbarDragMove:function(){this.params.lazy.enabled&&this.lazy.load()},transitionStart:function(){this.params.lazy.enabled&&(this.params.lazy.loadOnTransitionStart||!this.params.lazy.loadOnTransitionStart&&!this.lazy.initialImageLoaded)&&this.lazy.load()},transitionEnd:function(){this.params.lazy.enabled&&!this.params.lazy.loadOnTransitionStart&&this.lazy.load()}}},Controller={LinearSpline:function(e,t){var a,r,n,i,s,o=function(e,t){for(r=-1,a=e.length;a-r>1;)e[n=a+r>>1]<=t?r=n:a=n;return a};return this.x=e,this.y=t,this.lastIndex=e.length-1,this.interpolate=function(e){return e?(s=o(this.x,e),i=s-1,(e-this.x[i])*(this.y[s]-this.y[i])/(this.x[s]-this.x[i])+this.y[i]):0},this},getInterpolateFunction:function(e){this.controller.spline||(this.controller.spline=this.params.loop?new Controller.LinearSpline(this.slidesGrid,e.slidesGrid):new Controller.LinearSpline(this.snapGrid,e.snapGrid))},setTranslate:function(e,t){var a,r,n=this,i=n.controller.control;function s(e){var t=n.rtlTranslate?-n.translate:n.translate;"slide"===n.params.controller.by&&(n.controller.getInterpolateFunction(e),r=-n.controller.spline.interpolate(-t)),r&&"container"!==n.params.controller.by||(a=(e.maxTranslate()-e.minTranslate())/(n.maxTranslate()-n.minTranslate()),r=(t-n.minTranslate())*a+e.minTranslate()),n.params.controller.inverse&&(r=e.maxTranslate()-r),e.updateProgress(r),e.setTranslate(r,n),e.updateActiveIndex(),e.updateSlidesClasses()}if(Array.isArray(i))for(var o=0;o<i.length;o+=1)i[o]!==t&&i[o]instanceof Swiper&&s(i[o]);else i instanceof Swiper&&t!==i&&s(i)},setTransition:function(e,t){var a,r=this,n=r.controller.control;function i(t){t.setTransition(e,r),0!==e&&(t.transitionStart(),t.params.autoHeight&&Utils.nextTick(function(){t.updateAutoHeight()}),t.$wrapperEl.transitionEnd(function(){n&&(t.params.loop&&"slide"===r.params.controller.by&&t.loopFix(),t.transitionEnd())}))}if(Array.isArray(n))for(a=0;a<n.length;a+=1)n[a]!==t&&n[a]instanceof Swiper&&i(n[a]);else n instanceof Swiper&&t!==n&&i(n)}},Controller$1={name:"controller",params:{controller:{control:void 0,inverse:!1,by:"slide"}},create:function(){Utils.extend(this,{controller:{control:this.params.controller.control,getInterpolateFunction:Controller.getInterpolateFunction.bind(this),setTranslate:Controller.setTranslate.bind(this),setTransition:Controller.setTransition.bind(this)}})},on:{update:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},resize:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},observerUpdate:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},setTranslate:function(e,t){this.controller.control&&this.controller.setTranslate(e,t)},setTransition:function(e,t){this.controller.control&&this.controller.setTransition(e,t)}}},a11y={makeElFocusable:function(e){return e.attr("tabIndex","0"),e},addElRole:function(e,t){return e.attr("role",t),e},addElLabel:function(e,t){return e.attr("aria-label",t),e},disableEl:function(e){return e.attr("aria-disabled",!0),e},enableEl:function(e){return e.attr("aria-disabled",!1),e},onEnterKey:function(e){var t=this.params.a11y;if(13===e.keyCode){var a=$(e.target);this.navigation&&this.navigation.$nextEl&&a.is(this.navigation.$nextEl)&&(this.isEnd&&!this.params.loop||this.slideNext(),this.isEnd?this.a11y.notify(t.lastSlideMessage):this.a11y.notify(t.nextSlideMessage)),this.navigation&&this.navigation.$prevEl&&a.is(this.navigation.$prevEl)&&(this.isBeginning&&!this.params.loop||this.slidePrev(),this.isBeginning?this.a11y.notify(t.firstSlideMessage):this.a11y.notify(t.prevSlideMessage)),this.pagination&&a.is("."+this.params.pagination.bulletClass)&&a[0].click()}},notify:function(e){var t=this.a11y.liveRegion;0!==t.length&&(t.html(""),t.html(e))},updateNavigation:function(){if(!this.params.loop){var e=this.navigation,t=e.$nextEl,a=e.$prevEl;a&&a.length>0&&(this.isBeginning?this.a11y.disableEl(a):this.a11y.enableEl(a)),t&&t.length>0&&(this.isEnd?this.a11y.disableEl(t):this.a11y.enableEl(t))}},updatePagination:function(){var e=this,t=e.params.a11y;e.pagination&&e.params.pagination.clickable&&e.pagination.bullets&&e.pagination.bullets.length&&e.pagination.bullets.each(function(a,r){var n=$(r);e.a11y.makeElFocusable(n),e.a11y.addElRole(n,"button"),e.a11y.addElLabel(n,t.paginationBulletMessage.replace(/{{index}}/,n.index()+1))})},init:function(){this.$el.append(this.a11y.liveRegion);var e,t,a=this.params.a11y;this.navigation&&this.navigation.$nextEl&&(e=this.navigation.$nextEl),this.navigation&&this.navigation.$prevEl&&(t=this.navigation.$prevEl),e&&(this.a11y.makeElFocusable(e),this.a11y.addElRole(e,"button"),this.a11y.addElLabel(e,a.nextSlideMessage),e.on("keydown",this.a11y.onEnterKey)),t&&(this.a11y.makeElFocusable(t),this.a11y.addElRole(t,"button"),this.a11y.addElLabel(t,a.prevSlideMessage),t.on("keydown",this.a11y.onEnterKey)),this.pagination&&this.params.pagination.clickable&&this.pagination.bullets&&this.pagination.bullets.length&&this.pagination.$el.on("keydown","."+this.params.pagination.bulletClass,this.a11y.onEnterKey)},destroy:function(){var e,t;this.a11y.liveRegion&&this.a11y.liveRegion.length>0&&this.a11y.liveRegion.remove(),this.navigation&&this.navigation.$nextEl&&(e=this.navigation.$nextEl),this.navigation&&this.navigation.$prevEl&&(t=this.navigation.$prevEl),e&&e.off("keydown",this.a11y.onEnterKey),t&&t.off("keydown",this.a11y.onEnterKey),this.pagination&&this.params.pagination.clickable&&this.pagination.bullets&&this.pagination.bullets.length&&this.pagination.$el.off("keydown","."+this.params.pagination.bulletClass,this.a11y.onEnterKey)}},A11y={name:"a11y",params:{a11y:{enabled:!0,notificationClass:"swiper-notification",prevSlideMessage:"Previous slide",nextSlideMessage:"Next slide",firstSlideMessage:"This is the first slide",lastSlideMessage:"This is the last slide",paginationBulletMessage:"Go to slide {{index}}"}},create:function(){var e=this;Utils.extend(e,{a11y:{liveRegion:$('<span class="'+e.params.a11y.notificationClass+'" aria-live="assertive" aria-atomic="true"></span>')}}),Object.keys(a11y).forEach(function(t){e.a11y[t]=a11y[t].bind(e)})},on:{init:function(){this.params.a11y.enabled&&(this.a11y.init(),this.a11y.updateNavigation())},toEdge:function(){this.params.a11y.enabled&&this.a11y.updateNavigation()},fromEdge:function(){this.params.a11y.enabled&&this.a11y.updateNavigation()},paginationUpdate:function(){this.params.a11y.enabled&&this.a11y.updatePagination()},destroy:function(){this.params.a11y.enabled&&this.a11y.destroy()}}},Autoplay={run:function(){var e=this,t=e.slides.eq(e.activeIndex),a=e.params.autoplay.delay;t.attr("data-swiper-autoplay")&&(a=t.attr("data-swiper-autoplay")||e.params.autoplay.delay),e.autoplay.timeout=Utils.nextTick(function(){e.params.autoplay.reverseDirection?e.params.loop?(e.loopFix(),e.slidePrev(e.params.speed,!0,!0),e.emit("autoplay")):e.isBeginning?e.params.autoplay.stopOnLastSlide?e.autoplay.stop():(e.slideTo(e.slides.length-1,e.params.speed,!0,!0),e.emit("autoplay")):(e.slidePrev(e.params.speed,!0,!0),e.emit("autoplay")):e.params.loop?(e.loopFix(),e.slideNext(e.params.speed,!0,!0),e.emit("autoplay")):e.isEnd?e.params.autoplay.stopOnLastSlide?e.autoplay.stop():(e.slideTo(0,e.params.speed,!0,!0),e.emit("autoplay")):(e.slideNext(e.params.speed,!0,!0),e.emit("autoplay"))},a)},start:function(){return void 0===this.autoplay.timeout&&(!this.autoplay.running&&(this.autoplay.running=!0,this.emit("autoplayStart"),this.autoplay.run(),!0))},stop:function(){return!!this.autoplay.running&&(void 0!==this.autoplay.timeout&&(this.autoplay.timeout&&(clearTimeout(this.autoplay.timeout),this.autoplay.timeout=void 0),this.autoplay.running=!1,this.emit("autoplayStop"),!0))},pause:function(e){this.autoplay.running&&(this.autoplay.paused||(this.autoplay.timeout&&clearTimeout(this.autoplay.timeout),this.autoplay.paused=!0,0!==e&&this.params.autoplay.waitForTransition?(this.$wrapperEl[0].addEventListener("transitionend",this.autoplay.onTransitionEnd),this.$wrapperEl[0].addEventListener("webkitTransitionEnd",this.autoplay.onTransitionEnd)):(this.autoplay.paused=!1,this.autoplay.run())))}},Autoplay$1={name:"autoplay",params:{autoplay:{enabled:!1,delay:3e3,waitForTransition:!0,disableOnInteraction:!0,stopOnLastSlide:!1,reverseDirection:!1}},create:function(){var e=this;Utils.extend(e,{autoplay:{running:!1,paused:!1,run:Autoplay.run.bind(e),start:Autoplay.start.bind(e),stop:Autoplay.stop.bind(e),pause:Autoplay.pause.bind(e),onTransitionEnd:function(t){e&&!e.destroyed&&e.$wrapperEl&&t.target===this&&(e.$wrapperEl[0].removeEventListener("transitionend",e.autoplay.onTransitionEnd),e.$wrapperEl[0].removeEventListener("webkitTransitionEnd",e.autoplay.onTransitionEnd),e.autoplay.paused=!1,e.autoplay.running?e.autoplay.run():e.autoplay.stop())}}})},on:{init:function(){this.params.autoplay.enabled&&this.autoplay.start()},beforeTransitionStart:function(e,t){this.autoplay.running&&(t||!this.params.autoplay.disableOnInteraction?this.autoplay.pause(e):this.autoplay.stop())},sliderFirstMove:function(){this.autoplay.running&&(this.params.autoplay.disableOnInteraction?this.autoplay.stop():this.autoplay.pause())},destroy:function(){this.autoplay.running&&this.autoplay.stop()}}},Fade={setTranslate:function(){for(var e=this.slides,t=0;t<e.length;t+=1){var a=this.slides.eq(t),r=-a[0].swiperSlideOffset;this.params.virtualTranslate||(r-=this.translate);var n=0;this.isHorizontal()||(n=r,r=0);var i=this.params.fadeEffect.crossFade?Math.max(1-Math.abs(a[0].progress),0):1+Math.min(Math.max(a[0].progress,-1),0);a.css({opacity:i}).transform("translate3d("+r+"px, "+n+"px, 0px)")}},setTransition:function(e){var t=this,a=t.slides,r=t.$wrapperEl;if(a.transition(e),t.params.virtualTranslate&&0!==e){var n=!1;a.transitionEnd(function(){if(!n&&t&&!t.destroyed){n=!0,t.animating=!1;for(var e=["webkitTransitionEnd","transitionend"],a=0;a<e.length;a+=1)r.trigger(e[a])}})}}},EffectFade={name:"effect-fade",params:{fadeEffect:{crossFade:!1}},create:function(){Utils.extend(this,{fadeEffect:{setTranslate:Fade.setTranslate.bind(this),setTransition:Fade.setTransition.bind(this)}})},on:{beforeInit:function(){if("fade"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"fade");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,spaceBetween:0,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"fade"===this.params.effect&&this.fadeEffect.setTranslate()},setTransition:function(e){"fade"===this.params.effect&&this.fadeEffect.setTransition(e)}}},Cube={setTranslate:function(){var e,t=this.$el,a=this.$wrapperEl,r=this.slides,n=this.width,i=this.height,s=this.rtlTranslate,o=this.size,l=this.params.cubeEffect,p=this.isHorizontal(),c=this.virtual&&this.params.virtual.enabled,d=0;l.shadow&&(p?(0===(e=a.find(".swiper-cube-shadow")).length&&(e=$('<div class="swiper-cube-shadow"></div>'),a.append(e)),e.css({height:n+"px"})):0===(e=t.find(".swiper-cube-shadow")).length&&(e=$('<div class="swiper-cube-shadow"></div>'),t.append(e)));for(var u=0;u<r.length;u+=1){var h=r.eq(u),f=u;c&&(f=parseInt(h.attr("data-swiper-slide-index"),10));var v=90*f,m=Math.floor(v/360);s&&(v=-v,m=Math.floor(-v/360));var g=Math.max(Math.min(h[0].progress,1),-1),b=0,y=0,w=0;f%4==0?(b=4*-m*o,w=0):(f-1)%4==0?(b=0,w=4*-m*o):(f-2)%4==0?(b=o+4*m*o,w=o):(f-3)%4==0&&(b=-o,w=3*o+4*o*m),s&&(b=-b),p||(y=b,b=0);var C="rotateX("+(p?0:-v)+"deg) rotateY("+(p?v:0)+"deg) translate3d("+b+"px, "+y+"px, "+w+"px)";if(g<=1&&g>-1&&(d=90*f+90*g,s&&(d=90*-f-90*g)),h.transform(C),l.slideShadows){var x=p?h.find(".swiper-slide-shadow-left"):h.find(".swiper-slide-shadow-top"),E=p?h.find(".swiper-slide-shadow-right"):h.find(".swiper-slide-shadow-bottom");0===x.length&&(x=$('<div class="swiper-slide-shadow-'+(p?"left":"top")+'"></div>'),h.append(x)),0===E.length&&(E=$('<div class="swiper-slide-shadow-'+(p?"right":"bottom")+'"></div>'),h.append(E)),x.length&&(x[0].style.opacity=Math.max(-g,0)),E.length&&(E[0].style.opacity=Math.max(g,0))}}if(a.css({"-webkit-transform-origin":"50% 50% -"+o/2+"px","-moz-transform-origin":"50% 50% -"+o/2+"px","-ms-transform-origin":"50% 50% -"+o/2+"px","transform-origin":"50% 50% -"+o/2+"px"}),l.shadow)if(p)e.transform("translate3d(0px, "+(n/2+l.shadowOffset)+"px, "+-n/2+"px) rotateX(90deg) rotateZ(0deg) scale("+l.shadowScale+")");else{var k=Math.abs(d)-90*Math.floor(Math.abs(d)/90),S=1.5-(Math.sin(2*k*Math.PI/360)/2+Math.cos(2*k*Math.PI/360)/2),T=l.shadowScale,M=l.shadowScale/S,P=l.shadowOffset;e.transform("scale3d("+T+", 1, "+M+") translate3d(0px, "+(i/2+P)+"px, "+-i/2/M+"px) rotateX(-90deg)")}var O=Browser.isSafari||Browser.isUiWebView?-o/2:0;a.transform("translate3d(0px,0,"+O+"px) rotateX("+(this.isHorizontal()?0:d)+"deg) rotateY("+(this.isHorizontal()?-d:0)+"deg)")},setTransition:function(e){var t=this.$el;this.slides.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e),this.params.cubeEffect.shadow&&!this.isHorizontal()&&t.find(".swiper-cube-shadow").transition(e)}},EffectCube={name:"effect-cube",params:{cubeEffect:{slideShadows:!0,shadow:!0,shadowOffset:20,shadowScale:.94}},create:function(){Utils.extend(this,{cubeEffect:{setTranslate:Cube.setTranslate.bind(this),setTransition:Cube.setTransition.bind(this)}})},on:{beforeInit:function(){if("cube"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"cube"),this.classNames.push(this.params.containerModifierClass+"3d");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,resistanceRatio:0,spaceBetween:0,centeredSlides:!1,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"cube"===this.params.effect&&this.cubeEffect.setTranslate()},setTransition:function(e){"cube"===this.params.effect&&this.cubeEffect.setTransition(e)}}},Flip={setTranslate:function(){for(var e=this.slides,t=this.rtlTranslate,a=0;a<e.length;a+=1){var r=e.eq(a),n=r[0].progress;this.params.flipEffect.limitRotation&&(n=Math.max(Math.min(r[0].progress,1),-1));var i=-180*n,s=0,o=-r[0].swiperSlideOffset,l=0;if(this.isHorizontal()?t&&(i=-i):(l=o,o=0,s=-i,i=0),r[0].style.zIndex=-Math.abs(Math.round(n))+e.length,this.params.flipEffect.slideShadows){var p=this.isHorizontal()?r.find(".swiper-slide-shadow-left"):r.find(".swiper-slide-shadow-top"),c=this.isHorizontal()?r.find(".swiper-slide-shadow-right"):r.find(".swiper-slide-shadow-bottom");0===p.length&&(p=$('<div class="swiper-slide-shadow-'+(this.isHorizontal()?"left":"top")+'"></div>'),r.append(p)),0===c.length&&(c=$('<div class="swiper-slide-shadow-'+(this.isHorizontal()?"right":"bottom")+'"></div>'),r.append(c)),p.length&&(p[0].style.opacity=Math.max(-n,0)),c.length&&(c[0].style.opacity=Math.max(n,0))}r.transform("translate3d("+o+"px, "+l+"px, 0px) rotateX("+s+"deg) rotateY("+i+"deg)")}},setTransition:function(e){var t=this,a=t.slides,r=t.activeIndex,n=t.$wrapperEl;if(a.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e),t.params.virtualTranslate&&0!==e){var i=!1;a.eq(r).transitionEnd(function(){if(!i&&t&&!t.destroyed){i=!0,t.animating=!1;for(var e=["webkitTransitionEnd","transitionend"],a=0;a<e.length;a+=1)n.trigger(e[a])}})}}},EffectFlip={name:"effect-flip",params:{flipEffect:{slideShadows:!0,limitRotation:!0}},create:function(){Utils.extend(this,{flipEffect:{setTranslate:Flip.setTranslate.bind(this),setTransition:Flip.setTransition.bind(this)}})},on:{beforeInit:function(){if("flip"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"flip"),this.classNames.push(this.params.containerModifierClass+"3d");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,spaceBetween:0,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"flip"===this.params.effect&&this.flipEffect.setTranslate()},setTransition:function(e){"flip"===this.params.effect&&this.flipEffect.setTransition(e)}}},Coverflow={setTranslate:function(){for(var e=this.width,t=this.height,a=this.slides,r=this.$wrapperEl,n=this.slidesSizesGrid,i=this.params.coverflowEffect,s=this.isHorizontal(),o=this.translate,l=s?e/2-o:t/2-o,p=s?i.rotate:-i.rotate,c=i.depth,d=0,u=a.length;d<u;d+=1){var h=a.eq(d),f=n[d],v=(l-h[0].swiperSlideOffset-f/2)/f*i.modifier,m=s?p*v:0,g=s?0:p*v,b=-c*Math.abs(v),y=s?0:i.stretch*v,w=s?i.stretch*v:0;Math.abs(w)<.001&&(w=0),Math.abs(y)<.001&&(y=0),Math.abs(b)<.001&&(b=0),Math.abs(m)<.001&&(m=0),Math.abs(g)<.001&&(g=0);var C="translate3d("+w+"px,"+y+"px,"+b+"px)  rotateX("+g+"deg) rotateY("+m+"deg)";if(h.transform(C),h[0].style.zIndex=1-Math.abs(Math.round(v)),i.slideShadows){var x=s?h.find(".swiper-slide-shadow-left"):h.find(".swiper-slide-shadow-top"),E=s?h.find(".swiper-slide-shadow-right"):h.find(".swiper-slide-shadow-bottom");0===x.length&&(x=$('<div class="swiper-slide-shadow-'+(s?"left":"top")+'"></div>'),h.append(x)),0===E.length&&(E=$('<div class="swiper-slide-shadow-'+(s?"right":"bottom")+'"></div>'),h.append(E)),x.length&&(x[0].style.opacity=v>0?v:0),E.length&&(E[0].style.opacity=-v>0?-v:0)}}(Support.pointerEvents||Support.prefixedPointerEvents)&&(r[0].style.perspectiveOrigin=l+"px 50%")},setTransition:function(e){this.slides.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e)}},EffectCoverflow={name:"effect-coverflow",params:{coverflowEffect:{rotate:50,stretch:0,depth:100,modifier:1,slideShadows:!0}},create:function(){Utils.extend(this,{coverflowEffect:{setTranslate:Coverflow.setTranslate.bind(this),setTransition:Coverflow.setTransition.bind(this)}})},on:{beforeInit:function(){"coverflow"===this.params.effect&&(this.classNames.push(this.params.containerModifierClass+"coverflow"),this.classNames.push(this.params.containerModifierClass+"3d"),this.params.watchSlidesProgress=!0,this.originalParams.watchSlidesProgress=!0)},setTranslate:function(){"coverflow"===this.params.effect&&this.coverflowEffect.setTranslate()},setTransition:function(e){"coverflow"===this.params.effect&&this.coverflowEffect.setTransition(e)}}},Thumbs={init:function(){var e=this.params.thumbs,t=this.constructor;e.swiper instanceof t?(this.thumbs.swiper=e.swiper,Utils.extend(this.thumbs.swiper.originalParams,{watchSlidesProgress:!0,slideToClickedSlide:!1}),Utils.extend(this.thumbs.swiper.params,{watchSlidesProgress:!0,slideToClickedSlide:!1})):Utils.isObject(e.swiper)&&(this.thumbs.swiper=new t(Utils.extend({},e.swiper,{watchSlidesVisibility:!0,watchSlidesProgress:!0,slideToClickedSlide:!1})),this.thumbs.swiperCreated=!0),this.thumbs.swiper.$el.addClass(this.params.thumbs.thumbsContainerClass),this.thumbs.swiper.on("tap",this.thumbs.onThumbClick)},onThumbClick:function(){var e=this.thumbs.swiper;if(e){var t=e.clickedIndex,a=e.clickedSlide;if(!(a&&$(a).hasClass(this.params.thumbs.slideThumbActiveClass)||null==t)){var r;if(r=e.params.loop?parseInt($(e.clickedSlide).attr("data-swiper-slide-index"),10):t,this.params.loop){var n=this.activeIndex;this.slides.eq(n).hasClass(this.params.slideDuplicateClass)&&(this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft,n=this.activeIndex);var i=this.slides.eq(n).prevAll('[data-swiper-slide-index="'+r+'"]').eq(0).index(),s=this.slides.eq(n).nextAll('[data-swiper-slide-index="'+r+'"]').eq(0).index();r=void 0===i?s:void 0===s?i:s-n<n-i?s:i}this.slideTo(r)}}},update:function(e){var t=this.thumbs.swiper;if(t){var a="auto"===t.params.slidesPerView?t.slidesPerViewDynamic():t.params.slidesPerView;if(this.realIndex!==t.realIndex){var r,n=t.activeIndex;if(t.params.loop){t.slides.eq(n).hasClass(t.params.slideDuplicateClass)&&(t.loopFix(),t._clientLeft=t.$wrapperEl[0].clientLeft,n=t.activeIndex);var i=t.slides.eq(n).prevAll('[data-swiper-slide-index="'+this.realIndex+'"]').eq(0).index(),s=t.slides.eq(n).nextAll('[data-swiper-slide-index="'+this.realIndex+'"]').eq(0).index();r=void 0===i?s:void 0===s?i:s-n==n-i?n:s-n<n-i?s:i}else r=this.realIndex;t.visibleSlidesIndexes.indexOf(r)<0&&(t.params.centeredSlides?r=r>n?r-Math.floor(a/2)+1:r+Math.floor(a/2)-1:r>n&&(r=r-a+1),t.slideTo(r,e?0:void 0))}var o=1,l=this.params.thumbs.slideThumbActiveClass;if(this.params.slidesPerView>1&&!this.params.centeredSlides&&(o=this.params.slidesPerView),t.slides.removeClass(l),t.params.loop)for(var p=0;p<o;p+=1)t.$wrapperEl.children('[data-swiper-slide-index="'+(this.realIndex+p)+'"]').addClass(l);else for(var c=0;c<o;c+=1)t.slides.eq(this.realIndex+c).addClass(l)}}},Thumbs$1={name:"thumbs",params:{thumbs:{swiper:null,slideThumbActiveClass:"swiper-slide-thumb-active",thumbsContainerClass:"swiper-container-thumbs"}},create:function(){Utils.extend(this,{thumbs:{swiper:null,init:Thumbs.init.bind(this),update:Thumbs.update.bind(this),onThumbClick:Thumbs.onThumbClick.bind(this)}})},on:{beforeInit:function(){var e=this.params.thumbs;e&&e.swiper&&(this.thumbs.init(),this.thumbs.update(!0))},slideChange:function(){this.thumbs.swiper&&this.thumbs.update()},update:function(){this.thumbs.swiper&&this.thumbs.update()},resize:function(){this.thumbs.swiper&&this.thumbs.update()},observerUpdate:function(){this.thumbs.swiper&&this.thumbs.update()},setTransition:function(e){var t=this.thumbs.swiper;t&&t.setTransition(e)},beforeDestroy:function(){var e=this.thumbs.swiper;e&&this.thumbs.swiperCreated&&e&&e.destroy()}}};function initSwiper(e){var t=this,a=$(e);if(0!==a.length&&!a[0].swiper){var r,n,i,s={};a.hasClass("tabs-swipeable-wrap")&&(a.addClass("swiper-container").children(".tabs").addClass("swiper-wrapper").children(".tab").addClass("swiper-slide"),r=a.children(".tabs").children(".tab-active").index(),n=!0,i=a.find(".tabs-routable").length>0),a.attr("data-swiper")?s=JSON.parse(a.attr("data-swiper")):(s=a.dataset(),Object.keys(s).forEach(function(e){var t=s[e];if("string"==typeof t&&0===t.indexOf("{")&&t.indexOf("}")>0)try{s[e]=JSON.parse(t)}catch(e){}})),void 0===s.initialSlide&&void 0!==r&&(s.initialSlide=r);var o=t.swiper.create(a[0],s);n&&o.on("slideChange",function(){if(i){var e=t.views.get(a.parents(".view"));e||(e=t.views.main);var r=e.router,n=r.findTabRoute(o.slides.eq(o.activeIndex)[0]);n&&setTimeout(function(){r.navigate(n.path)},0)}else t.tab.show({tabEl:o.slides.eq(o.activeIndex)})})}}Swiper.use([Device$1,Browser$1,Support$1,Resize,Observer$1,Virtual$1,Navigation$1,Pagination$1,Scrollbar$1,Parallax$1,Zoom$1,Lazy$3,Controller$1,A11y,Autoplay$1,EffectFade,EffectCube,EffectFlip,EffectCoverflow,Thumbs$1]),window.Swiper||(window.Swiper=Swiper);var Swiper$1={name:"swiper",static:{Swiper:Swiper},create:function(){this.swiper=ConstructorMethods({defaultSelector:".swiper-container",constructor:Swiper,domProp:"swiper"})},on:{pageBeforeRemove:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){t.swiper.destroy(a)})},pageMounted:function(e){var t=this;e.$el.find(".tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},pageInit:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},pageReinit:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){var r=t.swiper.get(a);r&&r.update&&r.update()})},tabMounted:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},tabShow:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){var r=t.swiper.get(a);r&&r.update&&r.update()})},tabBeforeRemove:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){t.swiper.destroy(a)})}},vnode:{"swiper-init":{insert:function(e){var t=e.elm;initSwiper.call(this,t)},destroy:function(e){var t=e.elm;this.swiper.destroy(t)}},"tabs-swipeable-wrap":{insert:function(e){var t=e.elm;initSwiper.call(this,t)},destroy:function(e){var t=e.elm;this.swiper.destroy(t)}}}},PhotoBrowser=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this;r.app=t;var n=Utils.extend({on:{}},t.params.photoBrowser);r.useModulesParams(n),r.params=Utils.extend(n,a),Utils.extend(r,{exposed:!1,opened:!1,activeIndex:r.params.swiper.initialSlide,url:r.params.url,view:r.params.view||t.views.main,swipeToClose:{allow:!0,isTouched:!1,diff:void 0,start:void 0,current:void 0,started:!1,activeSlide:void 0,timeStart:void 0}}),r.useModules(),r.init()}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.onSlideChange=function(e){var t=this;t.activeIndex=e.activeIndex;var a=e.activeIndex+1,r=t.params.virtualSlides?t.params.photos.length:e.slides.length;e.params.loop&&(r-=2,(a-=e.loopedSlides)<1&&(a=r+a),a>r&&(a-=r));var n=t.params.virtualSlides?e.$wrapperEl.find('.swiper-slide[data-swiper-slide-index="'+e.activeIndex+'"]'):e.slides.eq(e.activeIndex),i=t.params.virtualSlides?e.$wrapperEl.find('.swiper-slide[data-swiper-slide-index="'+e.previousIndex+'"]'):e.slides.eq(e.previousIndex),s=t.$el.find(".photo-browser-current"),o=t.$el.find(".photo-browser-total");if("page"===t.params.type&&t.params.navbar&&0===s.length&&"ios"===t.app.theme){var l=t.app.navbar.getElByPage(t.$el);l&&(s=$(l).find(".photo-browser-current"),o=$(l).find(".photo-browser-total"))}if(s.text(a),o.text(r),t.captions.length>0){var p=e.params.loop?n.attr("data-swiper-slide-index"):t.activeIndex;t.$captionsContainerEl.find(".photo-browser-caption-active").removeClass("photo-browser-caption-active"),t.$captionsContainerEl.find('[data-caption-index="'+p+'"]').addClass("photo-browser-caption-active")}var c=i.find("video");c.length>0&&"pause"in c[0]&&c[0].pause()},t.prototype.onTouchStart=function(){var e=this.swipeToClose;e.allow&&(e.isTouched=!0)},t.prototype.onTouchMove=function(e){var t=this,a=t.swipeToClose;if(a.isTouched){a.started||(a.started=!0,a.start="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,t.params.virtualSlides?a.activeSlide=t.swiper.$wrapperEl.children(".swiper-slide-active"):a.activeSlide=t.swiper.slides.eq(t.swiper.activeIndex),a.timeStart=Utils.now()),e.preventDefault(),a.current="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,a.diff=a.start-a.current;var r=1-Math.abs(a.diff)/300,n=t.exposed||"dark"===t.params.theme?0:255;a.activeSlide.transform("translate3d(0,"+-a.diff+"px,0)"),t.swiper.$el.css("background-color","rgba("+n+", "+n+", "+n+", "+r+")").transition(0)}},t.prototype.onTouchEnd=function(){var e=this,t=e.swipeToClose;if(t.isTouched=!1,t.started){t.started=!1,t.allow=!1;var a=Math.abs(t.diff),r=(new Date).getTime()-t.timeStart;r<300&&a>20||r>=300&&a>100?Utils.nextTick(function(){e.$el&&(t.diff<0?e.$el.addClass("swipe-close-to-bottom"):e.$el.addClass("swipe-close-to-top")),e.emit("local::swipeToClose",e),e.close(),t.allow=!0}):(0!==a?t.activeSlide.addClass("photo-browser-transitioning").transitionEnd(function(){t.allow=!0,t.activeSlide.removeClass("photo-browser-transitioning")}):t.allow=!0,e.swiper.$el.transition("").css("background-color",""),t.activeSlide.transform(""))}else t.started=!1},t.prototype.renderNavbar=function(){var e=this;if(e.params.renderNavbar)return e.params.renderNavbar.call(e);var t=e.params.iconsColor;e.params.iconsColor||"dark"!==e.params.theme||(t="white");var a="ios"!==e.app.theme&&"aurora"!==e.app.theme||!e.params.backLinkText?"":e.params.backLinkText,r="page"!==e.params.type;return('\n      <div class="navbar">\n        <div class="navbar-inner sliding">\n          <div class="left">\n            <a href="#" class="link '+(r?"popup-close":"")+" "+(a?"":"icon-only")+" "+(r?"":"back")+'" '+(r?'data-popup=".photo-browser-popup"':"")+'>\n              <i class="icon icon-back '+(t?"color-"+t:"")+'"></i>\n              '+(a?"<span>"+a+"</span>":"")+'\n            </a>\n          </div>\n          <div class="title">\n            <span class="photo-browser-current"></span>\n            <span class="photo-browser-of">'+e.params.navbarOfText+'</span>\n            <span class="photo-browser-total"></span>\n          </div>\n          <div class="right"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderToolbar=function(){var e=this;if(e.params.renderToolbar)return e.params.renderToolbar.call(e);var t=e.params.iconsColor;return e.params.iconsColor||"dark"!==e.params.theme||(t="white"),('\n      <div class="toolbar toolbar-bottom tabbar">\n        <div class="toolbar-inner">\n          <a href="#" class="link photo-browser-prev">\n            <i class="icon icon-back '+(t?"color-"+t:"")+'"></i>\n          </a>\n          <a href="#" class="link photo-browser-next">\n            <i class="icon icon-forward '+(t?"color-"+t:"")+'"></i>\n          </a>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderCaption=function(e,t){return this.params.renderCaption?this.params.renderCaption.call(this,e,t):('\n      <div class="photo-browser-caption" data-caption-index="'+t+'">\n        '+e+"\n      </div>\n    ").trim()},t.prototype.renderObject=function(e,t){return this.params.renderObject?this.params.renderObject.call(this,e,t):'\n      <div class="photo-browser-slide photo-browser-object-slide swiper-slide" data-swiper-slide-index="'+t+'">'+(e.html?e.html:e)+"</div>\n    "},t.prototype.renderLazyPhoto=function(e,t){var a=this;return a.params.renderLazyPhoto?a.params.renderLazyPhoto.call(a,e,t):('\n      <div class="photo-browser-slide photo-browser-slide-lazy swiper-slide" data-swiper-slide-index="'+t+'">\n          <div class="preloader swiper-lazy-preloader '+("dark"===a.params.theme?"color-white":"")+'">'+(Utils[a.app.theme+"PreloaderContent"]||"")+'</div>\n          <span class="swiper-zoom-container">\n              <img data-src="'+(e.url?e.url:e)+'" class="swiper-lazy">\n          </span>\n      </div>\n    ').trim()},t.prototype.renderPhoto=function(e,t){return this.params.renderPhoto?this.params.renderPhoto.call(this,e,t):('\n      <div class="photo-browser-slide swiper-slide" data-swiper-slide-index="'+t+'">\n        <span class="swiper-zoom-container">\n          <img src="'+(e.url?e.url:e)+'">\n        </span>\n      </div>\n    ').trim()},t.prototype.render=function(){var e=this;return e.params.render?e.params.render.call(e,e.params):('\n      <div class="photo-browser photo-browser-'+e.params.theme+'">\n        <div class="view">\n          <div class="page photo-browser-page photo-browser-page-'+e.params.theme+" no-toolbar "+(e.params.navbar?"":"no-navbar")+'" data-name="photo-browser-page">\n            '+(e.params.navbar?e.renderNavbar():"")+"\n            "+(e.params.toolbar?e.renderToolbar():"")+'\n            <div class="photo-browser-captions photo-browser-captions-'+(e.params.captionsTheme||e.params.theme)+'">\n              '+e.params.photos.map(function(t,a){return t.caption?e.renderCaption(t.caption,a):""}).join(" ")+'\n            </div>\n            <div class="photo-browser-swiper-container swiper-container">\n              <div class="photo-browser-swiper-wrapper swiper-wrapper">\n                '+(e.params.virtualSlides?"":e.params.photos.map(function(t,a){return t.html||("string"==typeof t||t instanceof String)&&t.indexOf("<")>=0&&t.indexOf(">")>=0?e.renderObject(t,a):!0===e.params.swiper.lazy||e.params.swiper.lazy&&e.params.swiper.lazy.enabled?e.renderLazyPhoto(t,a):e.renderPhoto(t,a)}).join(" "))+"\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderStandalone=function(){return this.params.renderStandalone?this.params.renderStandalone.call(this):'<div class="popup photo-browser-popup photo-browser-standalone popup-tablet-fullscreen">'+this.render()+"</div>"},t.prototype.renderPage=function(){return this.params.renderPage?this.params.renderPage.call(this):this.render()},t.prototype.renderPopup=function(){return this.params.renderPopup?this.params.renderPopup.call(this):'<div class="popup photo-browser-popup">'+this.render()+"</div>"},t.prototype.onOpen=function(e,t){var a=this,r=a.app,n=$(t);n[0].f7PhotoBrowser=a,a.$el=n,a.el=n[0],a.openedIn=e,a.opened=!0,a.$swiperContainerEl=a.$el.find(".photo-browser-swiper-container"),a.$swiperWrapperEl=a.$el.find(".photo-browser-swiper-wrapper"),a.slides=a.$el.find(".photo-browser-slide"),a.$captionsContainerEl=a.$el.find(".photo-browser-captions"),a.captions=a.$el.find(".photo-browser-caption");var i=Utils.extend({},a.params.swiper,{initialSlide:a.activeIndex,on:{tap:function(e){a.emit("local::tap",e)},click:function(e){a.params.exposition&&a.expositionToggle(),a.emit("local::click",e)},doubleTap:function(e){a.emit("local::doubleTap",e)},slideChange:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.onSlideChange(this),a.emit.apply(a,["local::slideChange"].concat(e))},transitionStart:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::transitionStart"].concat(e))},transitionEnd:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::transitionEnd"].concat(e))},slideChangeTransitionStart:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::slideChangeTransitionStart"].concat(e))},slideChangeTransitionEnd:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::slideChangeTransitionEnd"].concat(e))},lazyImageLoad:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::lazyImageLoad"].concat(e))},lazyImageReady:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];$(e[0]).removeClass("photo-browser-slide-lazy"),a.emit.apply(a,["local::lazyImageReady"].concat(e))}}});a.params.swipeToClose&&"page"!==a.params.type&&Utils.extend(i.on,{touchStart:function(e){a.onTouchStart(e),a.emit("local::touchStart",e)},touchMoveOpposite:function(e){a.onTouchMove(e),a.emit("local::touchMoveOpposite",e)},touchEnd:function(e){a.onTouchEnd(e),a.emit("local::touchEnd",e)}}),a.params.virtualSlides&&Utils.extend(i,{virtual:{slides:a.params.photos,renderSlide:function(e,t){return e.html||("string"==typeof e||e instanceof String)&&e.indexOf("<")>=0&&e.indexOf(">")>=0?a.renderObject(e,t):!0===a.params.swiper.lazy||a.params.swiper.lazy&&a.params.swiper.lazy.enabled?a.renderLazyPhoto(e,t):a.renderPhoto(e,t)}}}),a.swiper=r.swiper.create(a.$swiperContainerEl,i),0===a.activeIndex&&a.onSlideChange(a.swiper),a.$el&&a.$el.trigger("photobrowser:open"),a.emit("local::open photoBrowserOpen",a)},t.prototype.onOpened=function(){this.$el&&this.$el.trigger("photobrowser:opened"),this.emit("local::opened photoBrowserOpened",this)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.swiper&&e.swiper.destroy&&(e.swiper.destroy(!0,!1),e.swiper=null,delete e.swiper),e.$el&&e.$el.trigger("photobrowser:close"),e.emit("local::close photoBrowserClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$el=null,e.el=null,delete e.$el,delete e.el,e.$el&&e.$el.trigger("photobrowser:closed"),e.emit("local::closed photoBrowserClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;var t=e.renderPage();return e.view.router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.view.$el.addClass("with-photo-browser-page with-photo-browser-page-"+e.params.theme),e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.view.$el.removeClass("with-photo-browser-page with-photo-browser-page-exposed with-photo-browser-page-"+e.params.theme),e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}}}}),e},t.prototype.openStandalone=function(){var e=this;if(e.opened)return e;var t={backdrop:!1,content:e.renderStandalone(),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;var t={content:e.renderPopup(),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(),e},t.prototype.expositionEnable=function(){var e=this;return"page"===e.params.type&&e.view.$el.addClass("with-photo-browser-page-exposed"),e.$el&&e.$el.addClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.addClass("photo-browser-captions-exposed"),e.exposed=!0,e},t.prototype.expositionDisable=function(){var e=this;return"page"===e.params.type&&e.view.$el.removeClass("with-photo-browser-page-exposed"),e.$el&&e.$el.removeClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.removeClass("photo-browser-captions-exposed"),e.exposed=!1,e},t.prototype.expositionToggle=function(){var e=this;return"page"===e.params.type&&e.view.$el.toggleClass("with-photo-browser-page-exposed"),e.$el&&e.$el.toggleClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.toggleClass("photo-browser-captions-exposed"),e.exposed=!e.exposed,e},t.prototype.open=function(e){var t=this,a=t.params.type;return t.opened?(t.swiper&&void 0!==e&&t.swiper.slideTo(parseInt(e,10)),t):(void 0!==e&&(t.activeIndex=e),"standalone"===a&&t.openStandalone(),"page"===a&&t.openPage(),"popup"===a&&t.openPopup(),t)},t.prototype.close=function(){var e=this;return e.opened?(e.params.routableModals||"page"===e.openedIn?e.view&&e.view.router.back():(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.modal.destroy(),delete e.modal})}),e.modal.close()),e):e},t.prototype.init=function(){},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy photoBrowserBeforeDestroy",e),e.$el&&(e.$el.trigger("photobrowser:beforedestroy"),e.$el[0].f7PhotoBrowser=null,delete e.$el[0].f7PhotoBrowser),Utils.deleteProps(e),e=null},t}(Framework7Class),PhotoBrowser$1={name:"photoBrowser",params:{photoBrowser:{photos:[],exposition:!0,expositionHideCaptions:!1,type:"standalone",navbar:!0,toolbar:!0,theme:"light",captionsTheme:void 0,iconsColor:void 0,swipeToClose:!0,backLinkText:"Close",navbarOfText:"of",view:void 0,url:"photos/",routableModals:!0,virtualSlides:!0,renderNavbar:void 0,renderToolbar:void 0,renderCaption:void 0,renderObject:void 0,renderLazyPhoto:void 0,renderPhoto:void 0,renderPage:void 0,renderPopup:void 0,renderStandalone:void 0,swiper:{initialSlide:0,spaceBetween:20,speed:300,loop:!1,preloadImages:!0,navigation:{nextEl:".photo-browser-next",prevEl:".photo-browser-prev"},zoom:{enabled:!0,maxRatio:3,minRatio:1},lazy:{enabled:!0}}}},create:function(){this.photoBrowser=ConstructorMethods({defaultSelector:".photo-browser",constructor:PhotoBrowser,app:this,domProp:"f7PhotoBrowser"})},static:{PhotoBrowser:PhotoBrowser}},Notification=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.notification,a);e.call(this,t,r);var n=this;n.app=t,n.params=r;var i,s,o,l,p,c,d,u=n.params,h=u.icon,f=u.title,v=u.titleRightText,m=u.subtitle,g=u.text,b=u.closeButton,y=u.closeTimeout,w=u.cssClass,C=u.closeOnClick;if(n.params.el)i=$(n.params.el);else{var x=n.render({icon:h,title:f,titleRightText:v,subtitle:m,text:g,closeButton:b,cssClass:w});i=$(x)}if(i&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(0===i.length)return n.destroy();Utils.extend(n,{$el:i,el:i[0],type:"notification"}),i[0].f7Modal=n,b&&i.find(".notification-close-button").on("click",function(){n.close()}),i.on("click",function(e){b&&$(e.target).closest(".notification-close-button").length||(n.emit("local::click notificationClick",n),C&&n.close())}),n.on("beforeDestroy",function(){i.off("click")});var E,k={};function S(e){s||(s=!0,o=!1,l=void 0,c=Utils.now(),k.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,k.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY)}function T(e){if(s){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;if(void 0===l&&(l=!!(l||Math.abs(a-k.y)<Math.abs(t-k.x))),l)s=!1;else{e.preventDefault(),o||(n.$el.removeClass("notification-transitioning"),n.$el.transition(0),d=n.$el[0].offsetHeight/2),o=!0;var r=p=a-k.y;p>0&&(r=Math.pow(p,.8)),n.$el.transform("translate3d(0, "+r+"px, 0)")}}}function M(){if(!s||!o)return s=!1,void(o=!1);if(s=!1,o=!1,0!==p){var e=Utils.now()-c;n.$el.transition(""),n.$el.addClass("notification-transitioning"),n.$el.transform(""),(p<-10&&e<300||-p>=d/1)&&n.close()}}return n.on("open",function(){n.params.swipeToClose&&(n.$el.on(t.touchEvents.start,S,{passive:!0}),t.on("touchmove:active",T),t.on("touchend:passive",M)),$(".notification.modal-in").each(function(e,a){var r=t.notification.get(a);a!==n.el&&r&&r.close()}),y&&function e(){E=Utils.nextTick(function(){s&&o?e():n.close()},y)}()}),n.on("close beforeDestroy",function(){n.params.swipeToClose&&(n.$el.off(t.touchEvents.start,S,{passive:!0}),t.off("touchmove:active",T),t.off("touchend:passive",M)),win.clearTimeout(E)}),n}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.icon,a=e.title,r=e.titleRightText,n=e.subtitle,i=e.text,s=e.closeButton;return('\n      <div class="notification '+(e.cssClass||"")+'">\n        <div class="notification-header">\n          '+(t?'<div class="notification-icon">'+t+"</div>":"")+"\n          "+(a?'<div class="notification-title">'+a+"</div>":"")+"\n          "+(r?'<div class="notification-title-right-text">'+r+"</div>":"")+"\n          "+(s?'<span class="notification-close-button"></span>':"")+'\n        </div>\n        <div class="notification-content">\n          '+(n?'<div class="notification-subtitle">'+n+"</div>":"")+"\n          "+(i?'<div class="notification-text">'+i+"</div>":"")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Notification$1={name:"notification",static:{Notification:Notification},create:function(){this.notification=Utils.extend({},ModalMethods({app:this,constructor:Notification,defaultSelector:".notification.modal-in"}))},params:{notification:{icon:null,title:null,titleRightText:null,subtitle:null,text:null,closeButton:!1,closeTimeout:null,closeOnClick:!1,swipeToClose:!0,cssClass:null,render:null}}},Autocomplete=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this;r.app=t;var n,i,s,o=Utils.extend({on:{}},t.params.autocomplete);void 0===o.searchbarDisableButton&&(o.searchbarDisableButton="aurora"!==t.theme),r.useModulesParams(o),r.params=Utils.extend(o,a),r.params.openerEl&&(n=$(r.params.openerEl)).length&&(n[0].f7Autocomplete=r),r.params.inputEl&&(i=$(r.params.inputEl)).length&&(i[0].f7Autocomplete=r),r.params.view?s=r.params.view:(n||i)&&(s=t.views.get(n||i)),s||(s=t.views.main);var l=Utils.id(),p=a.url;!p&&n&&n.length&&(n.attr("href")?p=n.attr("href"):n.find("a").length>0&&(p=n.find("a").attr("href"))),p&&"#"!==p&&""!==p||(p=r.params.url);var c=r.params.multiple?"checkbox":"radio";Utils.extend(r,{$openerEl:n,openerEl:n&&n[0],$inputEl:i,inputEl:i&&i[0],id:l,view:s,url:p,value:r.params.value||[],inputType:c,inputName:c+"-"+l,$modalEl:void 0,$dropdownEl:void 0});var d="";function u(){var e=r.$inputEl.val().trim();r.params.source&&r.params.source.call(r,e,function(t){var a,n,s,o="",l=r.params.limit?Math.min(r.params.limit,t.length):t.length;r.items=t,r.params.highlightMatches&&(e=e.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g,"\\$&"),a=new RegExp("("+e+")","i"));for(var p=0;p<l;p+=1){var c="object"==typeof t[p]?t[p][r.params.valueProperty]:t[p],u="object"==typeof t[p]?t[p][r.params.textProperty]:t[p];0===p&&(n=c,s=r.items[p]),o+=r.renderItem({value:c,text:r.params.highlightMatches?u.replace(a,"<b>$1</b>"):u},p)}if(""===o&&""===e&&r.params.dropdownPlaceholderText&&(o+=r.renderItem({placeholder:!0,text:r.params.dropdownPlaceholderText})),r.$dropdownEl.find("ul").html(o),r.params.typeahead){if(!n||!s)return;if(0!==n.toLowerCase().indexOf(e.toLowerCase()))return;if(d.toLowerCase()===e.toLowerCase())return void(r.value=[]);if(0===d.toLowerCase().indexOf(e.toLowerCase()))return d=e,void(r.value=[]);i.val(n),i[0].setSelectionRange(e.length,n.length);var h="object"==typeof r.value[0]?r.value[0][r.params.valueProperty]:r.value[0];h&&n.toLowerCase()===h.toLowerCase()||(r.value=[s],r.emit("local::change autocompleteChange",[s]))}d=e})}function h(){var e,t,a,n=this.value;if($(this).parents(".autocomplete-values").length>0){if("checkbox"===r.inputType&&!this.checked){for(var i=0;i<r.value.length;i+=1)(a="string"==typeof r.value[i]?r.value[i]:r.value[i][r.params.valueProperty])!==n&&1*a!=1*n||r.value.splice(i,1);r.updateValues(),r.emit("local::change autocompleteChange",r.value)}}else{for(var s=0;s<r.items.length;s+=1)(t="object"==typeof r.items[s]?r.items[s][r.params.valueProperty]:r.items[s])!==n&&1*t!=1*n||(e=r.items[s]);if("radio"===r.inputType)r.value=[e];else if(this.checked)r.value.push(e);else for(var o=0;o<r.value.length;o+=1)(a="object"==typeof r.value[o]?r.value[o][r.params.valueProperty]:r.value[o])!==n&&1*a!=1*n||r.value.splice(o,1);r.updateValues(),("radio"===r.inputType&&this.checked||"checkbox"===r.inputType)&&r.emit("local::change autocompleteChange",r.value)}}function f(e){var t=$(e.target);t.is(r.$inputEl[0])||r.$dropdownEl&&t.closest(r.$dropdownEl[0]).length||r.close()}function v(){r.open()}function m(){r.open()}function g(){r.$dropdownEl.find("label.active-state").length>0||setTimeout(function(){r.close()},0)}function b(){r.positionDropdown()}function y(e){r.opened&&13===e.keyCode&&(e.preventDefault(),r.$inputEl.blur())}function w(){for(var e,t=$(this),a=0;a<r.items.length;a+=1){var n="object"==typeof r.items[a]?r.items[a][r.params.valueProperty]:r.items[a],i=t.attr("data-value");n!==i&&1*n!=1*i||(e=r.items[a])}r.params.updateInputValueOnSelect&&(r.$inputEl.val("object"==typeof e?e[r.params.valueProperty]:e),r.$inputEl.trigger("input change")),r.value=[e],r.emit("local::change autocompleteChange",[e]),r.close()}return r.attachEvents=function(){"dropdown"!==r.params.openIn&&r.$openerEl&&r.$openerEl.on("click",v),"dropdown"===r.params.openIn&&r.$inputEl&&(r.$inputEl.on("focus",m),r.$inputEl.on(r.params.inputEvents,u),t.device.android?$("html").on("click",f):r.$inputEl.on("blur",g),r.params.typeahead&&r.$inputEl.on("keydown",y))},r.detachEvents=function(){"dropdown"!==r.params.openIn&&r.$openerEl&&r.$openerEl.off("click",v),"dropdown"===r.params.openIn&&r.$inputEl&&(r.$inputEl.off("focus",m),r.$inputEl.off(r.params.inputEvents,u),t.device.android?$("html").off("click",f):r.$inputEl.off("blur",g),r.params.typeahead&&r.$inputEl.off("keydown",y))},r.attachDropdownEvents=function(){r.$dropdownEl.on("click","label",w),t.on("resize",b)},r.detachDropdownEvents=function(){r.$dropdownEl.off("click","label",w),t.off("resize",b)},r.attachPageEvents=function(){r.$el.on("change",'input[type="radio"], input[type="checkbox"]',h),r.params.closeOnSelect&&!r.params.multiple&&r.$el.once("click",".list label",function(){Utils.nextTick(function(){r.close()})})},r.detachPageEvents=function(){r.$el.off("change",'input[type="radio"], input[type="checkbox"]',h)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.positionDropdown=function(){var e,t=this,a=t.$inputEl,r=t.app,n=t.$dropdownEl,i=a.parents(".page-content");if(0!==i.length){var s,o=a.offset(),l=a[0].offsetWidth,p=a[0].offsetHeight,c=a.parents(".list");c.parents().each(function(e,t){if(!s){var a=$(t);a.parent(i).length&&(s=a)}});var d,u=c.offset(),h=parseInt(i.css("padding-bottom"),10),f=c.length>0?u.left-i.offset().left:0,v=o.left-(c.length>0?u.left:0)-(r.rtl,0),m=o.top-(i.offset().top-i[0].scrollTop),g=i[0].scrollHeight-h-(m+i[0].scrollTop)-a[0].offsetHeight,b=r.rtl?"padding-right":"padding-left";c.length&&!t.params.expandInput&&(d=(r.rtl?c[0].offsetWidth-v-l:v)-("md"===r.theme?16:15)),n.css({left:(c.length>0?f:v)+"px",top:m+i[0].scrollTop+p+"px",width:(c.length>0?c[0].offsetWidth:l)+"px"}),n.children(".autocomplete-dropdown-inner").css(((e={maxHeight:g+"px"})[b]=c.length>0&&!t.params.expandInput?d+"px":"",e))}},t.prototype.focus=function(){this.$el.find("input[type=search]").focus()},t.prototype.source=function(e){var t=this;if(t.params.source){var a=t.$el;t.params.source.call(t,e,function(r){var n="",i=t.params.limit?Math.min(t.params.limit,r.length):r.length;t.items=r;for(var s=0;s<i;s+=1){for(var o=!1,l="object"==typeof r[s]?r[s][t.params.valueProperty]:r[s],p=0;p<t.value.length;p+=1){var c="object"==typeof t.value[p]?t.value[p][t.params.valueProperty]:t.value[p];c!==l&&1*c!=1*l||(o=!0)}n+=t.renderItem({value:l,text:"object"==typeof r[s]?r[s][t.params.textProperty]:r[s],inputType:t.inputType,id:t.id,inputName:t.inputName,selected:o},s)}a.find(".autocomplete-found ul").html(n),0===r.length?0!==e.length?(a.find(".autocomplete-not-found").show(),a.find(".autocomplete-found, .autocomplete-values").hide()):(a.find(".autocomplete-values").show(),a.find(".autocomplete-found, .autocomplete-not-found").hide()):(a.find(".autocomplete-found").show(),a.find(".autocomplete-not-found, .autocomplete-values").hide())})}},t.prototype.updateValues=function(){for(var e=this,t="",a=0;a<e.value.length;a+=1)t+=e.renderItem({value:"object"==typeof e.value[a]?e.value[a][e.params.valueProperty]:e.value[a],text:"object"==typeof e.value[a]?e.value[a][e.params.textProperty]:e.value[a],inputType:e.inputType,id:e.id,inputName:e.inputName+"-checked}",selected:!0},a);e.$el.find(".autocomplete-values ul").html(t)},t.prototype.preloaderHide=function(){"dropdown"===this.params.openIn&&this.$dropdownEl?this.$dropdownEl.find(".autocomplete-preloader").removeClass("autocomplete-preloader-visible"):$(".autocomplete-preloader").removeClass("autocomplete-preloader-visible")},t.prototype.preloaderShow=function(){"dropdown"===this.params.openIn&&this.$dropdownEl?this.$dropdownEl.find(".autocomplete-preloader").addClass("autocomplete-preloader-visible"):$(".autocomplete-preloader").addClass("autocomplete-preloader-visible")},t.prototype.renderPreloader=function(){return('\n      <div class="autocomplete-preloader preloader '+(this.params.preloaderColor?"color-"+this.params.preloaderColor:"")+'">'+(Utils[this.app.theme+"PreloaderContent"]||"")+"</div>\n    ").trim()},t.prototype.renderSearchbar=function(){var e=this;return e.params.renderSearchbar?e.params.renderSearchbar.call(e):('\n      <form class="searchbar">\n        <div class="searchbar-inner">\n          <div class="searchbar-input-wrap">\n            <input type="search" placeholder="'+e.params.searchbarPlaceholder+'"/>\n            <i class="searchbar-icon"></i>\n            <span class="input-clear-button"></span>\n          </div>\n          '+(e.params.searchbarDisableButton?'\n          <span class="searchbar-disable-button">'+e.params.searchbarDisableText+"</span>\n          ":"")+"\n        </div>\n      </form>\n    ").trim()},t.prototype.renderItem=function(e,t){if(this.params.renderItem)return this.params.renderItem.call(this,e,t);var a=e.value&&"string"==typeof e.value?e.value.replace(/"/g,"&quot;"):e.value;return("dropdown"!==this.params.openIn?'\n        <li>\n          <label class="item-'+e.inputType+' item-content">\n            <input type="'+e.inputType+'" name="'+e.inputName+'" value="'+a+'" '+(e.selected?"checked":"")+'>\n            <i class="icon icon-'+e.inputType+'"></i>\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ":e.placeholder?'\n        <li class="autocomplete-dropdown-placeholder">\n          <label class="item-content">\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ":'\n        <li>\n          <label class="item-radio item-content" data-value="'+a+'">\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ").trim()},t.prototype.renderNavbar=function(){var e=this;if(e.params.renderNavbar)return e.params.renderNavbar.call(e);var t=e.params.pageTitle;return void 0===t&&e.$openerEl&&e.$openerEl.length&&(t=e.$openerEl.find(".item-title").text().trim()),('\n      <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n        <div class="navbar-inner '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n          <div class="left sliding">\n            <a href="#" class="link '+("page"===e.params.openIn?"back":"popup-close")+'" '+("popup"===e.params.openIn?'data-popup=".autocomplete-popup"':"")+'>\n              <i class="icon icon-back"></i>\n              <span class="ios-only">'+("page"===e.params.openIn?e.params.pageBackLinkText:e.params.popupCloseLinkText)+"</span>\n            </a>\n          </div>\n          "+(t?'<div class="title sliding">'+t+"</div>":"")+"\n          "+(e.params.preloader?'\n          <div class="right">\n            '+e.renderPreloader()+"\n          </div>\n          ":"")+'\n          <div class="subnavbar sliding">'+e.renderSearchbar()+"</div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderDropdown=function(){var e=this;return e.params.renderDropdown?e.params.renderDropdown.call(e,e.items):('\n      <div class="autocomplete-dropdown">\n        <div class="autocomplete-dropdown-inner">\n          <div class="list '+(e.params.expandInput?"":"no-safe-areas")+'">\n            <ul></ul>\n          </div>\n        </div>\n        '+(e.params.preloader?e.renderPreloader():"")+"\n      </div>\n    ").trim()},t.prototype.renderPage=function(){var e=this;return e.params.renderPage?e.params.renderPage.call(e,e.items):('\n      <div class="page page-with-subnavbar autocomplete-page" data-name="autocomplete-page">\n        '+e.renderNavbar()+'\n        <div class="searchbar-backdrop"></div>\n        <div class="page-content">\n          <div class="list autocomplete-list autocomplete-found autocomplete-list-'+e.id+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n            <ul></ul>\n          </div>\n          <div class="list autocomplete-not-found">\n            <ul>\n              <li class="item-content"><div class="item-inner"><div class="item-title">'+e.params.notFoundText+'</div></div></li>\n            </ul>\n          </div>\n          <div class="list autocomplete-values">\n            <ul></ul>\n          </div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderPopup=function(){var e=this;return e.params.renderPopup?e.params.renderPopup.call(e,e.items):('\n      <div class="popup autocomplete-popup">\n        <div class="view">\n          '+e.renderPage()+";\n        </div>\n      </div>\n    ").trim()},t.prototype.onOpen=function(e,t){var a=this,r=a.app,n=$(t);if(a.$el=n,a.el=n[0],a.openedIn=e,a.opened=!0,"dropdown"===a.params.openIn)a.attachDropdownEvents(),a.$dropdownEl.addClass("autocomplete-dropdown-in"),a.$inputEl.trigger("input");else{var i=n.find(".searchbar");"page"===a.params.openIn&&"ios"===r.theme&&0===i.length&&(i=$(r.navbar.getElByPage(n)).find(".searchbar")),a.searchbar=r.searchbar.create({el:i,backdropEl:n.find(".searchbar-backdrop"),customSearch:!0,on:{search:function(e,t){0===t.length&&a.searchbar.enabled?a.searchbar.backdropShow():a.searchbar.backdropHide(),a.source(t)}}}),a.attachPageEvents(),a.updateValues(),a.params.requestSourceOnOpen&&a.source("")}a.emit("local::open autocompleteOpen",a)},t.prototype.autoFocus=function(){return this.searchbar&&this.searchbar.$inputEl&&this.searchbar.$inputEl.focus(),this},t.prototype.onOpened=function(){var e=this;"dropdown"!==e.params.openIn&&e.params.autoFocus&&e.autoFocus(),e.emit("local::opened autocompleteOpened",e)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.searchbar&&e.searchbar.destroy&&(e.searchbar.destroy(),e.searchbar=null,delete e.searchbar),"dropdown"===e.params.openIn?(e.detachDropdownEvents(),e.$dropdownEl.removeClass("autocomplete-dropdown-in").remove(),e.$inputEl.parents(".item-content-dropdown-expanded").removeClass("item-content-dropdown-expanded")):e.detachPageEvents(),e.emit("local::close autocompleteClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$el=null,e.el=null,delete e.$el,delete e.el,e.emit("local::closed autocompleteClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;var t=e.renderPage();return e.view.router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}},options:{animate:e.params.animate}}}),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;var t={content:e.renderPopup(),animate:e.params.animate,on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(e.params.animate),e},t.prototype.openDropdown=function(){var e=this;e.$dropdownEl||(e.$dropdownEl=$(e.renderDropdown())),e.$inputEl.parents(".list").length&&e.$inputEl.parents(".item-content").length>0&&e.params.expandInput&&e.$inputEl.parents(".item-content").addClass("item-content-dropdown-expanded");var t=e.$inputEl.parents(".page-content");e.params.dropdownContainerEl?$(e.params.dropdownContainerEl).append(e.$dropdownEl):0===t.length?e.$dropdownEl.insertAfter(e.$inputEl):(e.positionDropdown(),t.append(e.$dropdownEl)),e.onOpen("dropdown",e.$dropdownEl),e.onOpened("dropdown",e.$dropdownEl)},t.prototype.open=function(){var e=this;return e.opened?e:(e["open"+e.params.openIn.split("").map(function(e,t){return 0===t?e.toUpperCase():e}).join("")](),e)},t.prototype.close=function(){var e=this;return e.opened?("dropdown"===e.params.openIn?(e.onClose(),e.onClosed()):e.params.routableModals||"page"===e.openedIn?e.view.router.back({animate:e.params.animate}):(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.modal.destroy(),delete e.modal})}),e.modal.close()),e):e},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy autocompleteBeforeDestroy",e),e.detachEvents(),e.$inputEl&&e.$inputEl[0]&&delete e.$inputEl[0].f7Autocomplete,e.$openerEl&&e.$openerEl[0]&&delete e.$openerEl[0].f7Autocomplete,Utils.deleteProps(e),e.destroyed=!0},t}(Framework7Class),Autocomplete$1={name:"autocomplete",params:{autocomplete:{openerEl:void 0,inputEl:void 0,view:void 0,dropdownContainerEl:void 0,dropdownPlaceholderText:void 0,typeahead:!1,highlightMatches:!0,expandInput:!1,updateInputValueOnSelect:!0,inputEvents:"input",value:void 0,multiple:!1,source:void 0,limit:void 0,valueProperty:"id",textProperty:"text",openIn:"page",pageBackLinkText:"Back",popupCloseLinkText:"Close",pageTitle:void 0,searchbarPlaceholder:"Search...",searchbarDisableText:"Cancel",searchbarDisableButton:void 0,animate:!0,autoFocus:!1,closeOnSelect:!1,notFoundText:"Nothing found",requestSourceOnOpen:!1,preloaderColor:void 0,preloader:!1,formColorTheme:void 0,navbarColorTheme:void 0,routableModals:!0,url:"select/",renderDropdown:void 0,renderPage:void 0,renderPopup:void 0,renderItem:void 0,renderSearchbar:void 0,renderNavbar:void 0}},static:{Autocomplete:Autocomplete},create:function(){var e=this;e.autocomplete=Utils.extend(ConstructorMethods({defaultSelector:void 0,constructor:Autocomplete,app:e,domProp:"f7Autocomplete"}),{open:function(t){var a=e.autocomplete.get(t);if(a&&a.open)return a.open()},close:function(t){var a=e.autocomplete.get(t);if(a&&a.close)return a.close()}})}},Tooltip=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,t,a);var r=this,n=Utils.extend({},t.params.tooltip);r.useModulesParams(n),r.params=Utils.extend(n,a);var i=r.params.targetEl;if(!i)return r;var s=$(i);if(0===s.length)return r;if(s[0].f7Tooltip)return s[0].f7Tooltip;var o=$(r.render()).eq(0);Utils.extend(r,{app:t,$targetEl:s,targetEl:s&&s[0],$el:o,el:o&&o[0],text:r.params.text||"",visible:!1,opened:!1}),s[0].f7Tooltip=r;var l,p={};function c(e){l||(l=!0,p.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,p.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,r.show(this))}function d(e){if(l){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;Math.pow(Math.pow(t-p.x,2)+Math.pow(a-p.y,2),.5)>50&&(l=!1,r.hide())}}function u(){l&&(l=!1,r.hide())}function h(){r.show(this)}function f(){r.hide()}function v(){o.hasClass("tooltip-in")||o.removeClass("tooltip-out").remove()}return r.attachEvents=function(){if(o.on("transitionend",v),Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.on(t.touchEvents.start,c,e),t.on("touchmove",d),t.on("touchend:passive",u)}else s.on("mouseenter",h),s.on("mouseleave",f)},r.detachEvents=function(){if(o.off("transitionend",v),Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.off(t.touchEvents.start,c,e),t.off("touchmove",d),t.off("touchend:passive",u)}else s.off("mouseenter",h),s.off("mouseleave",f)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.position=function(e){var t=this.$el,a=this.app;t.css({left:"",top:""});var r,n,i,s,o=$(e||this.targetEl),l=[t.width(),t.height()],p=l[0],c=l[1];if(t.css({left:"",top:""}),o&&o.length>0){r=o.outerWidth(),n=o.outerHeight();var d=o.offset();i=d.left-a.left,s=d.top-a.top;var u=o.parents(".page");u.length>0&&(s-=u[0].scrollTop)}var h=[0,0,0],f=h[0],v=h[1],m="top";c<s?v=s-c:c<a.height-s-n?(m="bottom",v=s+n):(m="middle",(v=n/2+s-c/2)<=0?v=8:v+c>=a.height&&(v=a.height-c-8)),"top"===m||"bottom"===m?((f=r/2+i-p/2)<8&&(f=8),f+p>a.width&&(f=a.width-p-8),f<0&&(f=0)):"middle"===m&&((f=i-p)<8||f+p>a.width)&&(f<8&&(f=i+r),f+p>a.width&&(f=a.width-p-8)),t.css({top:v+"px",left:f+"px"})},t.prototype.show=function(e){var t=this.app,a=this.$el,r=this.$targetEl;t.root.append(a),this.position(e);var n=$(e);return this.visible=!0,this.opened=!0,r.trigger("tooltip:show",this),a.trigger("tooltip:show",this),n.length&&n[0]!==r[0]&&n.trigger("tooltip:show",this),this.emit("local::show tooltipShow",this),a.removeClass("tooltip-out").addClass("tooltip-in"),this},t.prototype.hide=function(){var e=this.$el,t=this.$targetEl;return this.visible=!1,this.opened=!1,t.trigger("tooltip:hide",this),e.trigger("tooltip:hide",this),this.emit("local::hide tooltipHide",this),e.addClass("tooltip-out").removeClass("tooltip-in"),this},t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params;return('\n      <div class="tooltip '+(e.cssClass||"")+'">\n        <div class="tooltip-content">'+(e.text||"")+"</div>\n      </div>\n    ").trim()},t.prototype.setText=function(e){return void 0===e?this:(this.params.text=e,this.text=e,this.$el&&this.$el.children(".tooltip-content").html(e),this.opened&&this.position(),this)},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){this.$targetEl&&!this.destroyed&&(this.$targetEl.trigger("tooltip:beforedestroy",this),this.emit("local::beforeDestroy tooltipBeforeDestroy",this),this.$el.remove(),delete this.$targetEl[0].f7Tooltip,this.detachEvents(),Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),Tooltip$1={name:"tooltip",static:{Tooltip:Tooltip},create:function(){this.tooltip=ConstructorMethods({defaultSelector:".tooltip",constructor:Tooltip,app:this,domProp:"f7Tooltip"}),this.tooltip.show=function(e){var t=$(e);if(0!==t.length){var a=t[0].f7Tooltip;if(a)return a.show(t[0]),a}},this.tooltip.hide=function(e){var t=$(e);if(0!==t.length){var a=t[0].f7Tooltip;if(a)return a.hide(),a}},this.tooltip.setText=function(e,t){var a=$(e);if(0!==a.length){var r=a[0].f7Tooltip;if(r)return r.setText(t),r}}},params:{tooltip:{targetEl:null,text:null,cssClass:null,render:null}},on:{tabMounted:function(e){var t=this;$(e).find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})})},tabBeforeRemove:function(e){$(e).find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()})},pageInit:function(e){var t=this;e.$el.find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})}),"ios"===t.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})})},pageBeforeRemove:function(e){e.$el.find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()}),"ios"===this.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()})}},vnode:{"tooltip-init":{insert:function(e){var t=e.elm,a=$(t).attr("data-tooltip");a&&this.tooltip.create({targetEl:t,text:a})},destroy:function(e){var t=e.elm;t.f7Tooltip&&t.f7Tooltip.destroy()}}}},Gauge=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,t,a);var r=Utils.extend({},t.params.gauge);this.useModulesParams(r),this.params=Utils.extend(r,a);var n=this.params.el;if(!n)return this;var i=$(n);return 0===i.length?this:i[0].f7Gauge?i[0].f7Gauge:(Utils.extend(this,{app:t,$el:i,el:i&&i[0]}),i[0].f7Gauge=this,this.useModules(),this.init(),this)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.calcRadius=function(){var e=this.params;return e.size/2-e.borderWidth/2},t.prototype.calcBorderLength=function(){var e=this.calcRadius();return 2*Math.PI*e},t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.type,a=e.value,r=e.size,n=e.bgColor,i=e.borderBgColor,s=e.borderColor,o=e.borderWidth,l=e.valueText,p=e.valueTextColor,c=e.valueFontSize,d=e.valueFontWeight,u=e.labelText,h=e.labelTextColor,f=e.labelFontSize,v=e.labelFontWeight,m="semicircle"===t,g=this.calcRadius(),b=this.calcBorderLength(),y=Math.max(Math.min(a,1),0);return('\n      <svg class="gauge-svg" width="'+r+'px" height="'+(m?r/2:r)+'px" viewBox="0 0 '+r+" "+(m?r/2:r)+'">\n        '+(m?'\n          <path\n            class="gauge-back-semi"\n            d="M'+(r-o/2)+","+r/2+" a1,1 0 0,0 -"+(r-o)+',0"\n            stroke="'+i+'"\n            stroke-width="'+o+'"\n            fill="'+(n||"none")+'"\n          />\n          <path\n            class="gauge-front-semi"\n            d="M'+(r-o/2)+","+r/2+" a1,1 0 0,0 -"+(r-o)+',0"\n            stroke="'+s+'"\n            stroke-width="'+o+'"\n            stroke-dasharray="'+b/2+'"\n            stroke-dashoffset="'+b/2*(1+y)+'"\n            fill="'+(i?"none":n||"none")+'"\n          />\n        ':"\n          "+(i?'\n            <circle\n              class="gauge-back-circle"\n              stroke="'+i+'"\n              stroke-width="'+o+'"\n              fill="'+(n||"none")+'"\n              cx="'+r/2+'"\n              cy="'+r/2+'"\n              r="'+g+'"\n            ></circle>\n          ':"")+'\n          <circle\n            class="gauge-front-circle"\n            transform="rotate(-90 '+r/2+" "+r/2+')"\n            stroke="'+s+'"\n            stroke-width="'+o+'"\n            stroke-dasharray="'+b+'"\n            stroke-dashoffset="'+b*(1-y)+'"\n            fill="'+(i?"none":n||"none")+'"\n            cx="'+r/2+'"\n            cy="'+r/2+'"\n            r="'+g+'"\n          ></circle>\n        ')+"\n        "+(l?'\n          <text\n            class="gauge-value-text"\n            x="50%"\n            y="'+(m?"100%":"50%")+'"\n            font-weight="'+d+'"\n            font-size="'+c+'"\n            fill="'+p+'"\n            dy="'+(m?u?-f-15:-5:0)+'"\n            text-anchor="middle"\n            dominant-baseline="'+(!m&&"middle")+'"\n          >'+l+"</text>\n        ":"")+"\n        "+(u?'\n          <text\n            class="gauge-label-text"\n            x="50%"\n            y="'+(m?"100%":"50%")+'"\n            font-weight="'+v+'"\n            font-size="'+f+'"\n            fill="'+h+'"\n            dy="'+(m?-5:l?c/2+10:0)+'"\n            text-anchor="middle"\n            dominant-baseline="'+(!m&&"middle")+'"\n          >'+u+"</text>\n        ":"")+"\n      </svg>\n    ").trim()},t.prototype.update=function(e){void 0===e&&(e={});var t=this.params,a=this.$gaugeSvgEl;if(Object.keys(e).forEach(function(a){void 0!==e[a]&&(t[a]=e[a])}),0===a.length)return this;var r=t.value,n=t.size,i=t.bgColor,s=t.borderBgColor,o=t.borderColor,l=t.borderWidth,p=t.valueText,c=t.valueTextColor,d=t.valueFontSize,u=t.valueFontWeight,h=t.labelText,f=t.labelTextColor,v=t.labelFontSize,m=t.labelFontWeight,g=this.calcBorderLength(),b=Math.max(Math.min(r,1),0),y=this.calcRadius(),w="semicircle"===t.type,C={width:n+"px",height:(w?n/2:n)+"px",viewBox:"0 0 "+n+" "+(w?n/2:n)};if(Object.keys(C).forEach(function(e){a.attr(e,C[e])}),w){var x={d:"M"+(n-l/2)+","+n/2+" a1,1 0 0,0 -"+(n-l)+",0",stroke:s,"stroke-width":l,fill:i||"none"},$={d:"M"+(n-l/2)+","+n/2+" a1,1 0 0,0 -"+(n-l)+",0",stroke:o,"stroke-width":l,"stroke-dasharray":g/2,"stroke-dashoffset":g/2*(b-1),fill:s?"none":i||"none"};Object.keys(x).forEach(function(e){a.find(".gauge-back-semi").attr(e,x[e])}),Object.keys($).forEach(function(e){a.find(".gauge-front-semi").attr(e,$[e])})}else{var E={stroke:s,"stroke-width":l,fill:i||"none",cx:n/2,cy:n/2,r:y},k={transform:"rotate(-90 "+n/2+" "+n/2+")",stroke:o,"stroke-width":l,"stroke-dasharray":g,"stroke-dashoffset":g*(1-b),fill:s?"none":i||"none",cx:n/2,cy:n/2,r:y};Object.keys(E).forEach(function(e){a.find(".gauge-back-circle").attr(e,E[e])}),Object.keys(k).forEach(function(e){a.find(".gauge-front-circle").attr(e,k[e])})}if(p){a.find(".gauge-value-text").length||a.append('<text class="gauge-value-text"></text>');var S={x:"50%",y:w?"100%":"50%","font-weight":u,"font-size":d,fill:c,dy:w?h?-v-15:-5:0,"text-anchor":"middle","dominant-baseline":!w&&"middle"};Object.keys(S).forEach(function(e){a.find(".gauge-value-text").attr(e,S[e])}),a.find(".gauge-value-text").text(p)}else a.find(".gauge-value-text").remove();if(h){a.find(".gauge-label-text").length||a.append('<text class="gauge-label-text"></text>');var T={x:"50%",y:w?"100%":"50%","font-weight":m,"font-size":v,fill:f,dy:w?-5:p?d/2+10:0,"text-anchor":"middle","dominant-baseline":!w&&"middle"};Object.keys(T).forEach(function(e){a.find(".gauge-label-text").attr(e,T[e])}),a.find(".gauge-label-text").text(h)}else a.find(".gauge-label-text").remove();return this},t.prototype.init=function(){var e=$(this.render()).eq(0);return e.f7Gauge=this,Utils.extend(this,{$gaugeSvgEl:e,gaugeSvgEl:e&&e[0]}),this.$el.append(e),this},t.prototype.destroy=function(){this.$el&&!this.destroyed&&(this.$el.trigger("gauge:beforedestroy",this),this.emit("local::beforeDestroy gaugeBeforeDestroy",this),this.$gaugeSvgEl.remove(),delete this.$el[0].f7Gauge,Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),Gauge$1={name:"gauge",static:{Gauge:Gauge},create:function(){var e=this;e.gauge=ConstructorMethods({defaultSelector:".gauge",constructor:Gauge,app:e,domProp:"f7Gauge"}),e.gauge.update=function(t,a){if(0!==$(t).length){var r=e.gauge.get(t);if(r)return r.update(a),r}}},params:{gauge:{el:null,type:"circle",value:0,size:200,bgColor:"transparent",borderBgColor:"#eeeeee",borderColor:"#000000",borderWidth:10,valueText:null,valueTextColor:"#000000",valueFontSize:31,valueFontWeight:500,labelText:null,labelTextColor:"#888888",labelFontSize:14,labelFontWeight:400}},on:{tabMounted:function(e){var t=this;$(e).find(".gauge-init").each(function(e,a){t.gauge.create(Utils.extend({el:a},$(a).dataset()||{}))})},tabBeforeRemove:function(e){$(e).find(".gauge-init").each(function(e,t){t.f7Gauge&&t.f7Gauge.destroy()})},pageInit:function(e){var t=this;e.$el.find(".gauge-init").each(function(e,a){t.gauge.create(Utils.extend({el:a},$(a).dataset()||{}))})},pageBeforeRemove:function(e){e.$el.find(".gauge-init").each(function(e,t){t.f7Gauge&&t.f7Gauge.destroy()})}},vnode:{"gauge-init":{insert:function(e){var t=e.elm;this.gauge.create(Utils.extend({el:t},$(t).dataset()||{}))},destroy:function(e){var t=e.elm;t.f7Gauge&&t.f7Gauge.destroy()}}}},Skeleton={name:"skeleton"},Menu={open:function(e){void 0===e&&(e=".menu-item-dropdown");if(e){var t=$(e).closest(".menu-item-dropdown");if(t.length){var a=t.closest(".menu").eq(0);if(a.length){var r=a.css("z-index"),n=a[0].style.zIndex;a.css("z-index",parseInt(r||0,0)+1),a[0].f7MenuZIndex=n}t.eq(0).addClass("menu-item-dropdown-opened").trigger("menu:opened"),this.emit("menuOpened",t.eq(0)[0])}}},close:function(e){void 0===e&&(e=".menu-item-dropdown-opened");if(e){var t=$(e).closest(".menu-item-dropdown-opened");if(t.length){var a=t.closest(".menu").eq(0);if(a.length){var r=a[0].f7MenuZIndex;a.css("z-index",r),delete a[0].f7MenuZIndex}t.eq(0).removeClass("menu-item-dropdown-opened").trigger("menu:closed"),this.emit("menuClosed",t.eq(0)[0])}}}},Menu$1={name:"menu",create:function(){this.menu={open:Menu.open.bind(this),close:Menu.close.bind(this)}},on:{click:function(e){var t=this,a=$(".menu-item-dropdown-opened");a.length&&a.each(function(a,r){$(e.target).closest(".menu-item-dropdown-opened").length||t.menu.close(r)})}},clicks:{".menu-item-dropdown":function(e,t,a){if(e.hasClass("menu-item-dropdown-opened")){if($(a.target).closest(".menu-dropdown").length)return;this.menu.close(e)}else this.menu.open(e)},".menu-close":function(){this.menu.close()}}},ViAd=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,n=this;if(!win.vi)throw new Error("Framework7: vi SDK not found.");void 0!==win.orientation&&(r=-90===win.orientation||90===win.orientation?"horizontal":"vertical");var i=Utils.extend({},t.params.vi,{appId:t.id,appVer:t.version,language:t.language,width:t.width,height:t.height,os:Device.os,osVersion:Device.osVersion,orientation:r});n.useModulesParams(i),n.params=Utils.extend(i,a);var s={},o="on autoplay fallbackOverlay fallbackOverlayText enabled".split(" ");if(Object.keys(n.params).forEach(function(e){if(!(o.indexOf(e)>=0)){var t=n.params[e];[null,void 0].indexOf(t)>=0||(s[e]=t)}}),!n.params.appId)throw new Error('Framework7: "app.id" is required to display an ad. Make sure you have specified it on app initialization.');if(!n.params.placementId)throw new Error('Framework7: "placementId" is required to display an ad.');function l(){var e=$("iframe#viAd");0!==e.length&&e.css({width:t.width+"px",height:t.height+"px"})}function p(){n.$overlayEl&&(n.$overlayEl.off("click touchstart"),n.$overlayEl.remove())}n.ad=new win.vi.Ad(s),Utils.extend(n.ad,{onAdReady:function(){t.on("resize",l),n.emit("local::ready"),n.params.autoplay&&n.start()},onAdStarted:function(){n.emit("local::started")},onAdClick:function(e){n.emit("local::click",e)},onAdImpression:function(){n.emit("local::impression")},onAdStopped:function(e){t.off("resize",l),p(),n.emit("local::stopped",e),"complete"===e&&(n.emit("local::complete"),n.emit("local::completed")),"userexit"===e&&n.emit("local::userexit"),n.destroyed=!0},onAutoPlayFailed:function(e,a){n.emit("local::autoplayFailed",e,a),e&&e.name&&-1!==e.name.indexOf("NotAllowedError")&&n.params.fallbackOverlay&&function(e){var a;e&&(n.$overlayEl=$(('\n        <div class="vi-overlay no-fastclick">\n          '+(n.params.fallbackOverlayText?'<div class="vi-overlay-text">'+n.params.fallbackOverlayText+"</div>":"")+'\n          <div class="vi-overlay-play-button"></div>\n        </div>\n      ').trim()),n.$overlayEl.on("touchstart",function(){a=Utils.now()}),n.$overlayEl.on("click",function(){if(!(Utils.now()-a>300)){if(e)return e.play(),void p();n.start(),p()}}),t.root.append(n.$overlayEl))}(a)},onAdError:function(e){p(),t.off("resize",l),n.emit("local::error",e),n.destroyed=!0}}),n.init(),Utils.extend(n,{app:t})}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.start=function(){this.destroyed||this.ad&&this.ad.startAd()},t.prototype.pause=function(){this.destroyed||this.ad&&this.ad.pauseAd()},t.prototype.resume=function(){this.destroyed||this.ad&&this.ad.resumeAd()},t.prototype.stop=function(){this.destroyed||this.ad&&this.ad.stopAd()},t.prototype.init=function(){this.destroyed||this.ad&&this.ad.initAd()},t.prototype.destroy=function(){this.destroyed=!0,this.emit("local::beforeDestroy"),Utils.deleteProps(this)},t}(Framework7Class),Vi={name:"vi",params:{vi:{enabled:!1,autoplay:!0,fallbackOverlay:!0,fallbackOverlayText:"Please watch this ad",showMute:!0,startMuted:(Device.ios||Device.android)&&!Device.cordova,appId:null,appVer:null,language:null,width:null,height:null,placementId:"pltd4o7ibb9rc653x14",placementType:"interstitial",videoSlot:null,showProgress:!0,showBranding:!0,os:null,osVersion:null,orientation:null,age:null,gender:null,advertiserId:null,latitude:null,longitude:null,accuracy:null,storeId:null,ip:null,manufacturer:null,model:null,connectionType:null,connectionProvider:null}},create:function(){var e=this;e.vi={sdkReady:!1,createAd:function(t){return new ViAd(e,t)},loadSdk:function(){if(!e.vi.sdkReady){var t=doc.createElement("script");t.onload=function(){e.emit("viSdkReady"),e.vi.sdkReady=!0},t.src="https://c.vi-serve.com/viadshtml/vi.min.js",$("head").append(t)}}}},on:{init:function(){(this.params.vi.enabled||this.passedParams.vi&&!1!==this.passedParams.vi.enabled)&&this.vi.loadSdk()}}},Elevation={name:"elevation"},Typography={name:"typography"};return"undefined"!=typeof window&&(window.Template7||(window.Template7=Template7),window.Dom7||(window.Dom7=$)),Router.use([RouterTemplateLoaderModule,RouterComponentLoaderModule]),Framework7.use([DeviceModule,SupportModule,UtilsModule,ResizeModule,RequestModule,TouchModule,ClicksModule,Router$1,HistoryModule,StorageModule,ComponentModule,ServiceWorkerModule,Statusbar$1,View$1,Navbar$1,Toolbar$1,Subnavbar,TouchRipple$1,Modal$1,Appbar,Dialog$1,Popup$1,LoginScreen$1,Popover$1,Actions$1,Sheet$1,Toast$1,Preloader$1,Progressbar$1,Sortable$1,Swipeout$1,Accordion$1,ContactsList,VirtualList$1,ListIndex$1,Timeline,Tabs,Panel$1,Card,Chip,Form,Input$1,Checkbox,Radio,Toggle$1,Range$1,Stepper$1,SmartSelect$1,Grid,Calendar$1,Picker$1,InfiniteScroll$1,PullToRefresh$1,Lazy$1,DataTable$1,Fab$1,Searchbar$1,Messages$1,Messagebar$1,Swiper$1,PhotoBrowser$1,Notification$1,Autocomplete$1,Tooltip$1,Gauge$1,Skeleton,Menu$1,Vi,Elevation,Typography]),Framework7});
//# sourceMappingURL=framework7.bundle.min.js.map
$_mod.def("/app$1.0.0/src/routes/mobile/index.marko.init", function(require, exports, module, __filename, __dirname) { window.$initComponents && window.$initComponents();
});
$_mod.run("/app$1.0.0/src/routes/mobile/index.marko.init");