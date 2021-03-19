/**
 * Changes:
 * > Added eachFileMatchingSorted: variant of eachFileMatching with results sorted.
 * > Modified readFile method to support caching of file.
 *   > Method signature is now readFile(relpath, encoding, cache, callback)
 *     > cache is optional to indicate whether to use cache. If true:
 *     > If file modification time has not changed and it exists in cache,
 *       the cached copy is returned.
 *       O.w. file is re-read, cached and returned.
 *   > Cache is global (and not per scoped instance).
 * > Changed default to '' instead of '/'.
 *   > '' gives access to all drives, whereas '/' gives access to current path.
 * > Added option to 'lock' to root folder. I.e. all relative paths provided
 *   will not be allowed to navigate above root folder.
 *   If an attempt is made to navigate above root folder (e.g. using '..'),
 *   no error will be thrown; the path will merely be resolved as far as possible,
 *   and capped to the root folder (and will most likely be non-existent).
 * > Added fileutils.
 * > JSLint refactoring.
 *
 * Based on scopedfs V0.1.0.
 *
 * @modified DS
 **/

//JSLint static code analysis options:
/*jslint node: true, continue:true, nomen:true, plusplus: true, sloppy: true, stupid: true, ass: true, todo: true, white: true, maxerr: 10, indent: 4 */

var Path = require('path'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    rimraf = require('rimraf'),
    temp = require('temp'),
    fileutils = require('fileutils'),
    //For caching files read by readFile():
    cachedFiles = {},    //map of cached files: { <filename>"?"<timestamp>: {mtime: <file modified time>, data: <data>} }
    loadingFiles = {};   //map of files being loaded to interested parties: { <filename>"?"<timestamp>: [callback] }

function ScopedFS(path, locked)
{
    var k, v;
    this.path = path;
    this.locked = !!locked; //true means navigation above root folder is disallowed.
    for (k in this)
    {
        if (this.hasOwnProperty(k))
        {
            v = this[k];
            if (typeof v === 'function')
            {
                this[k] = v.bind(this);
            }
        }
    }
}

//
// SD: readFile shim - adds caching support
//

/**
 * Asynchronus file read with optional caching.
 * @param cache (bool, optional) indicates whether to use cache.
 *   If true:
 *     If file modification time has not changed and it exists in cache,
 *     the cached copy is returned.
 *     O.w. file is re-read, cached and returned.
 *   O.w. plain old readFile is called.
 **/
ScopedFS.prototype.readFile = function(relpath, encoding, cache, callback) {
    function returnData(err, data, cb)
    {
        if (typeof cb === 'function')
        {
            if (err)
            {
                cb(err);
                return;
            }
            if (typeof data === 'string')
            {
                cb(false, data);
            }
            else //raw buffer
            {
                //return a copy of buffer
                var newBuf = new Buffer(data.length);
                data.copy(newBuf);
                cb(false, newBuf);
            }
        }
    }
    function returnData2All(key, data)
    {
        var waitingParties = loadingFiles[key],
            cnt, i;
        delete loadingFiles[key];
        if (waitingParties)
        {
            cnt = waitingParties.length;
            for (i = 0; i < cnt; ++i)
            {
                returnData(false, data, waitingParties[i]);
            }
        }
    }
    function returnError2All(key, err)
    {
        var waitingParties = loadingFiles[key],
            cnt, i, cb;
        delete loadingFiles[key];
        if (waitingParties)
        {
            cnt = waitingParties.length;
            for (i = 0; i < cnt; ++i)
            {
                cb = waitingParties[i];
                if (typeof cb === 'function')
                {
                    cb(err);
                }
            }
        }
    }

    //Validate inputs
    if (typeof encoding === 'function')
    {
        //only path & callback given as input parameters
        callback = encoding;
        encoding = null;
        cache = false;
    }
    else if (typeof encoding === 'boolean')
    {
        //path, cache & callback given as input parameters
        callback = cache;
        cache = encoding;
        encoding = null;
    }
    else
    {
        //only path, encoding & callback given as input parameters
        if (typeof cache === 'function')
        {
            callback = cache;
            cache = false;
        }
        else
        {
            cache = !!cache;
        }
    }
    if (typeof relpath !== 'string')
    {
        returnData('Bad argument: path must be a string!', null, callback);
        return;
    }
    var realpath = this.pathOf(relpath),
        key;
    if ((encoding !== null) && (typeof encoding === 'object'))
    {
        key = realpath + '?' + JSON.stringify(encoding);
    }
    else
    {
        if (typeof encoding !== 'string')
        {
            encoding = null;
        }
        key = realpath + '?' + encoding;
    }

    if (!cache)
    {
        //normal readFile call without caching:
        return fs.readFile(realpath, encoding, callback);
    }

    //readFile with caching:
    this.stat(relpath, function(err, stats) {
        if (err)
        {
            returnData(err, undefined, callback);
            return;
        }
        var mtime = stats.mtime.getTime(),
            waitingParties;
        if (!cachedFiles[key]
            || !cachedFiles[key].mtime
            || (mtime !== cachedFiles[key].mtime))
        {
            delete cachedFiles[key];
            waitingParties = loadingFiles[key];
            if (waitingParties === undefined) //start reload only if not already started
            {
                waitingParties = loadingFiles[key] = [];
                fs.readFile(realpath, encoding, function(err, data) {
                    if (err)
                    {
                        returnError2All(key, err);
                        return;
                    }
                    cachedFiles[key] = {
                        mtime: mtime,
                        data: data
                    };
                    returnData2All(key, data);
                });
            }
            waitingParties.push(callback); //register to get file data when it's loaded
        }
        else //already in cache and file not changed
        {
            returnData(false, cachedFiles[key].data, callback); //return copy from cache
        }
    });
};

/**
 * Purge all old cached files (read using readFile).
 * Reads in progress are not purged.
 **/
ScopedFS.prototype.purgeCache = function()
{
    var key;
    for (key in cachedFiles)
    {
        if (cachedFiles.hasOwnProperty(key) && (loadingFiles[key] === undefined))
        {
            delete cachedFiles[key];
        }
    }
};

//
// SD: Auto-populate shims for all 'fs' metehods
//

/**
 * 'scopedfs' needs to translate (relative) path inputs to absolute paths,
 * thus 'fs' methods with 1 or 2 path inputs have to be shim'd specially.
 * For new APIs, we'll print a notice and try shimming it anyway as a *single path* input method!
 **/

//list of 'fs' methods that takes in a path as 1st input parameter:
const fnSinglePath = [
    'access',
    'stat',
    'chown',
    'lchown',
    'chmod',
    'lchmod',
    'lstat',
    'readlink',
    'realpath',
    'unlink',
    'rmdir',
    'mkdir',
    'readdir',
    'readFile',
    'writeFile',
    'appendFile',
    'exists',
    'createReadStream',
    'open',
    'unwatchFile',
    'watch',
    'watchFile',
    'utimes',
    'lutimes'
];
//list of 'fs' methods that takes in a path as 1st input parameter, but without sync version:
const fnSinglePathNoSync = [
    'createWriteStream'
];
//list of 'fs' methods that takes in 2 paths as 1st & 2nd input parameters:
const fnDoublePath = [
    'rename',
    'link',
    'symlink',
    'copyFile'
];
//list of 'fs' methods that does not take in a path as 1st input parameter:
const fnNoPath = [
    'truncate',
    'fchown',
    'fchmod',
    'close',
    'futimes',
    'fsync',
    'write',
    'read',
    'fdatasync',
    'fstat',
    'ftruncate',
    'mkdtemp',
    'writev'
];
//list of 'fs' methods that does not take in a path as 1st input parameter, and has no sync version:
const fnNoPathNoSync = [
    '_toUnixTimestamp'
];
const fnSinglePathSync = fnSinglePath.map((name) => `${name}Sync` );
const fnDoublePathSync = fnDoublePath.map((name) => `${name}Sync` );
const fnNoPathSync = fnNoPath.map((name) => `${name}Sync` );

function shimFnSinglePath(orgFn, fnName)
{
    if (typeof ScopedFS.prototype[fnName] === 'function')
    {
        return; //already exists, skip
    }
    ScopedFS.prototype[fnName] = function(oldpath, ...rest)
    {
        return orgFn(this.pathOf(oldpath), ...rest);
    };
}
//for new APIs, we'll shim it as a possible single path input, and print a warning Once.
function shimFnSinglePathWithWarning(orgFn, fnName)
{
    if (typeof ScopedFS.prototype[fnName] === 'function')
    {
        return; //already exists, skip
    }
    const warned = {};
    ScopedFS.prototype[fnName] = function(oldpath, ...rest)
    {
        if (!warned[fnName])
        {
            warned[fnName] = true;
            console.log(`scopedfs:: new method '${fnName}' used!`);
        }
        //try and detect is 1st input argument is a path type
        if ((typeof oldpath === 'string')
            || (oldpath instanceof Buffer)
            //|| (oldpath instanceof URL) //scopedfs won's support URL
            )
        {
            return orgFn(this.pathOf(oldpath), ...rest);
        }
        return orgFn(oldpath, ...rest);
    };
}
fnSinglePath.forEach((fnName) => {
    shimFnSinglePath(fs[fnName], fnName);
    const fnNameSync = `${fnName}Sync`;
    shimFnSinglePath(fs[fnNameSync], fnNameSync);
});
fnSinglePathNoSync.forEach((fnName) => {
    shimFnSinglePath(fs[fnName], fnName);
});

function shimFnDoublePath(orgFn, fnName)
{
    if (typeof ScopedFS.prototype[fnName] === 'function')
    {
        return; //already exists, skip
    }
    ScopedFS.prototype[fnName] = function(oldpath, newpath, ...rest)
    {
        return orgFn(
            this.pathOf(oldpath),
            this.pathOf(newpath),
            ...rest);
    };
}
fnDoublePath.forEach((fnName) => {
    shimFnDoublePath(fs[fnName], fnName);
    const fnNameSync = `${fnName}Sync`;
    shimFnDoublePath(fs[fnNameSync], fnNameSync);
});

function shimFnNoPath(orgFn, fnName)
{
    if (typeof ScopedFS.prototype[fnName] === 'function')
    {
        return; //already exists, skip
    }
    ScopedFS.prototype[fnName] = function()
    {
        return orgFn(...arguments);
    };
}
fnNoPath.forEach((fnName) => {
    shimFnNoPath(fs[fnName], fnName);
    const fnNameSync = `${fnName}Sync`;
    shimFnNoPath(fs[fnNameSync], fnNameSync);
});
fnNoPathNoSync.forEach((fnName) => {
    shimFnNoPath(fs[fnName], fnName);
});
//copy other attributes & detect new 'fs' API methods
const ignoredClassNames = [
    'Dirent',
    'Stats',
    'ReadStream',
    'WriteStream',
    'FileReadStream',
    'FileWriteStream'
];
const fnNames = Object.keys(fs);
fnNames.forEach((fnName) => {
    const elem = fs[fnName];
    if (typeof elem !== 'function')
    {
        ScopedFS.prototype[fnName] = elem;
    }
    //for developer use: detect new 'fs' API methods:
    else
    {
        //detect new methods
        if (!fnSinglePath.includes(fnName)
            && !fnSinglePathSync.includes(fnName)
            && !fnDoublePath.includes(fnName)
            && !fnDoublePathSync.includes(fnName)
            && !fnNoPath.includes(fnName)
            && !fnNoPathSync.includes(fnName)
            && !fnSinglePathNoSync.includes(fnName)
            && !fnNoPathNoSync.includes(fnName)
            && !ignoredClassNames.includes(fnName))
        {
            //console.log(`scopedfs:: Detected and shim'd NEW fs method: ${fnName}`);
            shimFnSinglePathWithWarning(fs[fnName], fnName);
        }
    }
});

//
// Additions (not in original fs)
//

ScopedFS.prototype.rmrf = function(path, callback) {
    return rimraf(this.pathOf(path), callback);
};

ScopedFS.prototype.rmrfSync = function(path) {
    return rimraf.sync(this.pathOf(path));
};

ScopedFS.prototype.mkdirp = function(path, mode, callback) {
    return mkdirp(this.pathOf(path), mode, callback);
};

ScopedFS.prototype.mkdirpSync = function(path, mode) {
    return mkdirp.sync(this.pathOf(path), mode);
};

ScopedFS.prototype.putSync = function(relpath, data, encoding) {
    this.mkdirpSync(Path.dirname(relpath));
    return this.writeFileSync(relpath, data, encoding);
};

ScopedFS.prototype.applySync = function(update) {
    var content, relpath, _results;
    _results = [];
    for (relpath in update) {
        if (update.hasOwnProperty(relpath))
        {
            content = update[relpath];
            if (typeof content === 'function') {
                _results.push(content(this.pathOf(relpath)));
            } else if (content !== null) {
                if (relpath.match(/\/$/)) {
                    _results.push(this.mkdirpSync(relpath.replace(/\/$/, '')));
                } else {
                    _results.push(this.putSync(relpath, content));
                }
            } else {
                _results.push(this.rmrfSync(relpath, content));
            }
        }
    }
    return _results;
};

//SD: Add fileutils methods
ScopedFS.prototype.eachFile = function(path, recurse, callback, completeHandler)
{
    return fileutils.eachFile(this.pathOf(path), recurse, callback, completeHandler);
};
ScopedFS.prototype.eachDirectory = function(path, recurse, callback, completeHandler)
{
    return fileutils.eachDirectory(this.pathOf(path), recurse, callback, completeHandler);
};
ScopedFS.prototype.eachFileMatching = function(expression, path, recurse, callback, completeHandler)
{
    return fileutils.eachFileMatching(expression, this.pathOf(path), recurse, callback, completeHandler);
};
ScopedFS.prototype.eachFileMatchingSorted = function(expression, path, recurse, keygen, compare, callback, completeHandler)
{
    return fileutils.eachFileMatchingSorted(expression, this.pathOf(path), recurse, keygen, compare, callback, completeHandler);
};
ScopedFS.prototype.eachFileOrDirectory = function(directory, recurse, fileHandler, completeHandler)
{
    return fileutils.eachFileOrDirectory(this.pathOf(directory), recurse, fileHandler, completeHandler);
};
ScopedFS.prototype.readEachFileMatching = function(expression, path, recurse, callback, completeHandler)
{
    return fileutils.readEachFileMatching(expression, this.pathOf(path), recurse, callback, completeHandler);
};

ScopedFS.prototype.pathOf = function(relpath) {
    //SD: Support Buffer in lieu of string like fs does
    if (relpath instanceof Buffer)
    {
        relpath = relpath.toString('utf8');
    }
    return Path.join(this.path, !this.locked? relpath:
        //SD: if locked, disallow navigation above root path:
        Path.normalize(Path.sep + relpath));
};

ScopedFS.prototype.scoped = function(relpath, locked) {
    return new ScopedFS(this.pathOf(relpath || ''), locked);
};

ScopedFS.prototype.createTempFS = function(affixes) {
    return new ScopedFS(temp.mkdirSync(affixes));
};

//SD: changed default from '/' to '', so we won't be locked to Node.JS drive or lalaland.
module.exports = new ScopedFS('');
module.exports.ScopedFS = ScopedFS;
