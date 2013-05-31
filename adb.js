var console = require('console');
var net = require('net');
var events = require('events');
var util = require('util');

var DebugBridge = exports.DebugBridge = function () {
    if (!DebugBridge.initialized) {
        DebugBridge.initialize();
        DebugBridge.initialized = true;
    }

    this.autoStartDaemon = true;
    this.debug = false;
};

util.inherits(DebugBridge, events.EventEmitter);

var DebugSession = function (adb, sock) {
    this.adb = adb;
    this.sock = sock;
};

util.inherits(DebugSession, events.EventEmitter);

DebugBridge.DEFAULT_PORT = 5037;

DebugBridge.initialized = false;
DebugBridge.initialize = function () {
    process.on('uncaughtException', function (err) {
        console.error('Caught exception: ' + err);
        console.error(err.stack);
    });

    process.on('SIGINT', function () {
        DebugBridge.log('log','Got SIGINT, exiting...');

        process.exit(0);
    });

    process.on('exit', function () {
        DebugBridge.log('log','About to exit.');
    });
};

DebugBridge.log = function (level, msg) {
    if (level == 'error') {
        console.error(msg);
    } else if (DebugBridge.debug) {
        if (level in console) {
            console.call(level, msg, this);
        }
    }
};

DebugBridge.start_server = function (callback /* (code: number) */) {
    var spawn = require('child_process').spawn;

    var adb = spawn('./' + require('os').platform() + '/adb', ['start-server']);

    adb.stdout.on('data', function (data) {
        DebugBridge.log('log','stdout: ' + data);
    });

    adb.stderr.on('data', function (data) {
        DebugBridge.log('log','stderr: ' + data);
    });

    adb.on('exit', function (code) {
        callback(code);
    });
    adb.stdin.end();
};

DebugBridge.kill_server = function () {

};

DebugBridge.prototype.connect = function (callback /* (session: DebugSession) */) {
    var adb = this;

    var sock = net.connect({ port: DebugBridge.DEFAULT_PORT }, function () {
        DebugBridge.log('log','client connected to %s:%d', sock.remoteAddress, sock.remotePort);

        sock.session = new DebugSession(adb, sock);
        adb.emit('connected', sock.session);

        callback(sock.session);
    });

    sock.setKeepAlive(true);
    sock.setNoDelay(true);
    sock.on('end', function () {
        DebugBridge.log('log','client disconnected');

        sock.session.emit('disconnected');

        sock.end();
    });
    sock.on('timeout', function () {
        DebugBridge.log('log','client timeout');
    });
    sock.on('error', function (err) {
        if ('ECONNREFUSED' == err.errno) {
            DebugBridge.log('log','client connect refused, restarting adb daemon...');

            if (adb.autoStartDaemon) {
                DebugBridge.start_server(function (code) {
                    DebugBridge.log('log','start adb daemon: %d', code);

                    if (code == 0) {
                        adb.connect(callback);
                    }
                });

                return;
            }
        } else {
            console.error('client caught exception: ' + err);
        }

        throw err;
    });
};

function encodeNumber(len) {
    var buf = '';

    for (var i=3; i>=0; i--) {
        buf += '0123456789ABCDEF'.charAt((len >> 4*i) & 0xF);
    }

    return buf;
}

function decodeNumber(str) {
    var num = 0;

    for (var i=0; i<str.length; i++) {
        num = num * 16 + '0123456789ABCDEF'.indexOf(String.fromCharCode(str[i]).toUpperCase());
    }

    return num;
}

DebugSession.prototype.sendData = function (data) {
    var buf = encodeNumber(data.length) + data;

    DebugBridge.log('log','send %d bytes: %s', buf.length, buf);

    this.sock.write(buf);
};

DebugSession.prototype.parseCmdResult = function (data, callback /* (data: buffer) */) {
    var code = data.slice(0, 4).toString();

    if (code == 'OKAY') {
        DebugBridge.log('log','exec command succeeded');

        this.parseData(data.slice(4), callback);
    } else if (code == 'FAIL') {
        DebugBridge.log('log','exec command failed');

        this.parseData(data.slice(4), function (msg) {
            throw new Error(msg);
        });
    } else {
        throw new Error('Unknown result code - ' + code);
    }

    return code;
}

DebugSession.prototype.parseData = function (data, callback /* (data: buffer) */) {
    var session = this;

    if (data.length == 0) {
        callback(null);
        return;
    }

    var len = decodeNumber(data.slice(0, 4));

    DebugBridge.log('log','found %d bytes data: %s', len, data.slice(4, 4+len));

    if (data.length < len+4) {
        // TODO wait for the remaining data
    } else {
        callback(data.slice(4, 4+len));

        if (data.length > 4+len) {
            session.parseData(data.slice(4+len), callback);
        }
    }
};

DebugSession.prototype.waitCmdResult = function (callback /* (data: buffer) */) {
    var session = this;

    this.sock.once('data', function (data) {
        DebugBridge.log('log','recv %d bytes data: %s', data.length, data);

        session.parseCmdResult(data, callback);
    });
};

DebugSession.prototype.recvData = function (callback /* (data: buffer) */) {
    this.sock.on('data', callback);
};

DebugSession.prototype.onClosed = function onClosed(callback) {
    this.sock.on('close', callback);
};

DebugBridge.prototype.execCommand = function (cmd, callback /* (data: buffer) */, repeat) {
    this.connect(function (session) {
        session.waitCmdResult(callback, repeat);
        session.sendData(cmd);
    });
};

DebugBridge.TRANSPORT_USB = 'host:transport-usb';
DebugBridge.TRANSPORT_LOCAL = 'host:transport-local';
DebugBridge.TRANSPORT_ANY = 'host:transport-any';

DebugBridge.prototype.prepareTransport = function (sn_or_type, callback) {
    this.connect(function (session) {
        session.waitCmdResult(function (data) {
            callback(session);
        });

        var cmd;

        if (sn_or_type.indexOf('host:transport-') == 0) {
            cmd = sn_or_type;
        } else {
            cmd = 'host:transport:' + sn_or_type;
        }

        session.sendData(cmd);
    });
};

DebugBridge.prototype.getVersion = function (callback /* (version: number) */) {
    this.execCommand('host:version', function (data) {
        callback(decodeNumber(data));
    });
};

function parseDevices(adb, data) {
    var lines = data.toString().split('\n');
    var devices = [];

    for (var i=0; i<lines.length; i++) {
        var o = lines[i].split('\t');

        if (o.length == 2) {
            devices.push(new AndroidDevice(adb, o[0], o[1]));
        }
    }

    return devices;
}

DebugBridge.prototype.listDevices = function (callback /* (devices: AndroidDevice[]) */) {
    var adb = this;

    this.execCommand('host:devices', function (data) {
        callback(parseDevices(adb, data));
    });
};

DebugBridge.prototype.traceDevice = function (callback /* (devices: AndroidDevice[]) */) {
    var adb = this;

    this.execCommand('host:track-devices', function (data) {
        callback(parseDevices(adb, data));
    }, true);
};

DebugBridge.prototype.forward = function forward(local, remote, callback) {
    var adb = this;

    this.connect(function onConnect(session) {
        session.sendData('host:forward:' + local + ';' + remote);
        callback();
    })
}

var AndroidDevice = function (adb, id, type) {
    this.adb = adb;
    this.id = id;
    this.type = type;
};

AndroidDevice.prototype.toString = function () {
    return util.format('<%s %s>', this.type, this.id);
};

Object.defineProperty(AndroidDevice.prototype, 'isEmulator', {
    get: function () {
        return this.id.indexOf("emulator-") == 0;
    }
});

AndroidDevice.prototype.logcat = function onLogCat() {
    this.adb.prepareTransport(this.id, function onTransport(session) {
        session.waitCmdResult(function onResult(cmdResult) {
            session.recvData(function onData(data) {
                /*
                struct logger_entry {
                    uint16_t    len;    // length of the payload
                    uint16_t    __pad;  // no matter what, we get 2 bytes of padding
                    int32_t     pid;    // generating process's pid
                    int32_t     tid;    // generating process's tid
                    int32_t     sec;    // seconds since Epoch
                    int32_t     nsec;   // nanoseconds
                    char        msg[0]; // the entry's payload
                };
                */
                var len = data.readUInt16LE(0);
                var pid = data.readUInt32LE(4);
                var tid = data.readUInt32LE(8);
                var date = new Date(data.readUInt32LE(12) * 1000);
                var msg = data.slice(20);
                console.log('[' + date + '] ' + msg);
                
            });
        });
        session.sendData('log:main');
    });
};

AndroidDevice.prototype.shellCmd = function onShellCmd(cmd, args, callback) {
    if (cmd === null || typeof cmd !== 'string') {
        callback(null);
        return;
    }

    var payload = cmd;

    if (args != null && Array.isArray(args)) {
        for(var i = 0; i < args.length; i++) {
            if (typeof args[i] == 'string') {
                args[i] = args[i].replace('"','');
            }
        }

        payload += ' ' + args.join(' ');
    }
    this.adb.prepareTransport(this.id, function onTransport(session) {
        var buffer = [];
        session.waitCmdResult( function onResult(cmdResult) {
            session.recvData(function onData(data) {
                var chunk = data.toString();
                if (chunk && chunk.length > 0) {
                    buffer.push(chunk);
                }
            })
        });
        session.onClosed(function onClosed() {
            if (callback) {
                callback(buffer.join(''));
            } else {
                console.log(buffer.join(''));
            }
        });
        session.sendData('shell:' + payload);
    });
};

AndroidDevice.prototype.takeSnapshot = function (callback /* (frame: Framebuffer) */) {
    this.adb.prepareTransport(this.id, function (session) {
        session.waitCmdResult(function (data) {
            session.recvData(function (data) {
                if (!session.frame) {
                    session.frame = new AndroidFrame();
                }

                session.frame.parseData(data);

                if (session.frame.isFinished) {
                    var frame = session.frame;

                    session.frame = null;

                    callback(frame);
                }
            }, true);
        });
        session.sendData('framebuffer:');
    });
};

AndroidDevice.prototype.getSyncService = function (callback /* (svc: SyncService) */) {
    this.adb.prepareTransport(this.id, function (session) {
        session.waitCmdResult(function (data) {
            callback(new SyncService(session));
        });
        session.sendData('sync:');
    });
};

var AndroidFrame = function () {
};

AndroidFrame.prototype.toString = function () {
    return util.format('<frame %dx%d@%d with %d bytes>', this.width, this.height, this.depth, this.size);
};

Object.defineProperty(AndroidFrame.prototype, 'isFinished', {
    get: function () {
        return this.pixels && (this.size == this.pixels.length);
    }
});

function getMask(length) {
    return (1 << length) - 1;
}

AndroidFrame.prototype.convertRGB565toARGB = function (pixels) {
    var buf = new Buffer(this.width * this.height * 4);

    for (var x=0; x<this.width; x++) {
        for (var y=0; y<this.height; y++) {
            var idx = (y * this.width + x) * 2;
            var value = (pixels[idx] & 0xFF) | ((pixels[idx+1] << 8) & 0xFF00);

            var r = ((value >>> this.red_offset) & getMask(this.red_length)) << (8 - this.red_length);
            var g = ((value >>> this.green_offset) & getMask(this.green_length)) << (8 - this.green_length);
            var b = ((value >>> this.blue_offset) & getMask(this.blue_length)) << (8 - this.blue_length);

            idx = (y * this.width + x) * 4;
            buf[idx++] = b;
            buf[idx++] = g;
            buf[idx++] = r;
            buf[idx] = a;
        }
    }

    return buf;
};

AndroidFrame.prototype.parseFrameHeader = function (data) {
    var version = this.pixels.readUInt32LE(0);

    if (version == 1) {
        this.depth = this.pixels.readUInt32LE(4);
        this.size = this.pixels.readUInt32LE(8);
        this.width = this.pixels.readUInt32LE(12);
        this.height = this.pixels.readUInt32LE(16);

        // create default values for the rest. Format is 565
        this.red_offset = this.pixels.readUInt32LE(20);
        this.red_length = this.pixels.readUInt32LE(24);
        this.green_offset = this.pixels.readUInt32LE(28);
        this.green_length = this.pixels.readUInt32LE(32);
        this.blue_offset = this.pixels.readUInt32LE(36);
        this.blue_length = this.pixels.readUInt32LE(40);
        this.alpha_offset = this.pixels.readUInt32LE(44);
        this.alpha_length = this.pixels.readUInt32LE(48);

        this.pixels = this.pixels.slice(13*4);
    } else if (version == 16) {
        this.depth = 16;
        this.size = this.pixels.readUInt32LE(4);
        this.width = this.pixels.readUInt32LE(8);
        this.height = this.pixels.readUInt32LE(12);

        // create default values for the rest. Format is 565
        this.red_offset = 11;
        this.red_length = 5;
        this.green_offset = 5;
        this.green_length = 6;
        this.blue_offset = 0;
        this.blue_length = 5;
        this.alpha_offset = 0;
        this.alpha_length = 0;

        this.pixels = this.pixels.slice(16);
    }

    console.log('found a %dx%d@%d frame with %d bytes', this.width, this.height, this.depth, this.size);
};

AndroidFrame.prototype.parseData = function (data) {
    if (this.pixels) {
        // console.log("append %d bytes: %s", data.length, data.inspect());

        this.pixels = Buffer.concat([this.pixels, data], this.pixels.length + data.length);

        if (this.pixels.length == this.size && this.depth == 16) {
            this.pixels = this.convertRGB565toARGB(this.pixels);
            this.size = this.pixels.length;
        }
    } else {
        this.pixels = data;
    }

    if (!this.size && this.pixels.length >= 16) {
        this.parseFrameHeader(data);
    }
};

AndroidFrame.prototype.writeImageFile = function (filename) {
    console.log("generating %dx%d image from %d bytes buffer ...", this.width, this.height, this.pixels.length);

    var ext = require('path').extname(filename);
    var Image;

    if (ext == '.png') {
        Image = require('png').Png;
    } else if (ext == '.jpg') {
        Image = require('jpeg').Jpeg;
    } else if (ext == '.gif') {
        Image = require('gif').Gif;
    } else {
        throw new Error("unknown image type - " + ext);
    }

    img = new Image(this.pixels, this.width, this.height, 'rgba');

    img.encode(function (image, err) {
        console.log("writing %d bytes Image file ...", image.length);

        if (err) { throw new Error(err); }

        require('fs').writeFile(filename, image.toString('binary'), 'binary', function (err) {
            if (err) {
                console.error(err);
            } else {
                var spawn = require('child_process').spawn;

                spawn('open', [filename]);
            }
        });
    });
};

var SyncService = function (session) {
    this.session = session;
};

util.inherits(SyncService, events.EventEmitter);

SyncService.REMOTE_PATH_MAX_LENGTH = 1024;

SyncService.ID_OKAY = 'OKAY';
SyncService.ID_FAIL = 'FAIL';
SyncService.ID_STAT = 'STAT';
SyncService.ID_RECV = 'RECV';
SyncService.ID_DATA = 'DATA';
SyncService.ID_DONE = 'DONE';
SyncService.ID_SEND = 'SEND';
SyncService.ID_LIST = 'LIST';
SyncService.ID_DENT = 'DENT';
SyncService.ID_ULNK = 'ULNK';
SyncService.ID_QUIT = 'QUIT';

SyncService.prototype.createFileReq = function (cmd, path) {
    var buf = new Buffer(8 + path.length);

    buf.write(cmd, 0, 4, 'binary');
    buf.writeUInt32LE(path.length, 4);
    buf.write(path, 8, path.length, 'binary');

    return buf;
};

SyncService.prototype.sendFileReq = function (cmd, path) {
    var req = this.createFileReq(cmd, path);

    console.log("send file %s request %s", cmd, req.inspect());

    this.session.sock.write(req);
};

var StreamWriter = function (filename) {
    this.stream = require('fs').createWriteStream(filename, { encoding: 'binary'});
    this.ts = new Date().getTime();

    this.totalSize = 0;
    this.chunkSize = 0;
    this.closed = false;
};

StreamWriter.prototype.close = function () {
    this.stream.end();
    this.closed = true;
};

StreamWriter.prototype.parseData = function (data) {
    if (this.chunkSize > 0) {
        var buf = data.length > this.chunkSize ? data.slice(0, this.chunkSize) : data;
        var remaining = data.length > this.chunkSize ? data.slice(this.chunkSize) : null;

        this.stream.write(buf);

        this.totalSize += buf.length;
        this.chunkSize -= buf.length;

        if (remaining) this.parseData(remaining);
    } else {
        var id = data.slice(0, 4).toString();
        var size = data.readUInt32LE(4);

        //console.log("found id <%s> with %d bytes", id, size);

        if (id == SyncService.ID_DATA) {
            this.chunkSize = size;

            this.parseData(data.slice(8));
        } else if (id == SyncService.ID_DONE) {
            console.log("receiving %d bytes file in %d KB/s", this.totalSize, this.recvSpeed);

            this.close();
        } else if (id == SyncService.ID_FAIL) {
            var msg = data.slice(8, size).toString();

            throw new Error('Adb Transfer Protocol Error, ' + msg);
        } else {
            throw new Error('Adb Transfer Protocol Error, unknown id - ' + id);
        }
    }
};

Object.defineProperty(StreamWriter.prototype, 'recvTimes', {
    get: function () {
        return new Date().getTime() - this.ts;
    }
});

Object.defineProperty(StreamWriter.prototype, 'recvSpeed', {
    get: function () {
        return Math.round(new Number(this.totalSize) * 1000 / this.recvTimes / 1024 * 100) / 100;
    }
});

SyncService.prototype.pullFile = function (remotePath, localPath, callback /* (size) */) {
    if (remotePath.length > SyncService.REMOTE_PATH_MAX_LENGTH) {
        throw new Error('Remote path is too long.');
    }

    var writer = new StreamWriter(localPath);

    this.session.sock.on('data', function (data) {
        //console.log("recv %d bytes %s", data.length, data.inspect());

        writer.parseData(data);

        if (writer.closed) callback(writer.totalSize);
    });

    this.sendFileReq(SyncService.ID_RECV, remotePath);
};