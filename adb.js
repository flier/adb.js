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
        console.log('Got SIGINT, exiting...');

        process.exit(0);
    });

    process.on('exit', function () {
        console.log('About to exit.');
    });
};

DebugBridge.start_server = function (callback /* (code: number) */) {
    var spawn = require('child_process').spawn;

    var adb = spawn('./adb', ['start-server']);

    adb.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });

    adb.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
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
        console.log('client connected to %s:%d', sock.remoteAddress, sock.remotePort);

        sock.session = new DebugSession(adb, sock);
        adb.emit('connected', sock.session);

        callback(sock.session);
    });

    sock.setKeepAlive(true);
    sock.setNoDelay(true);
    sock.on('end', function () {
        console.log('client disconnected');

        sock.session.emit('disconnected');

        sock.end();
    });
    sock.on('timeout', function () {
        console.log('client timeout');
    });
    sock.on('error', function (err) {
        if ('ECONNREFUSED' == err.errno) {
            console.log('client connect refused, restarting adb daemon...');

            if (adb.autoStartDaemon) {
                DebugBridge.start_server(function (code) {
                    console.log('start adb daemon: %d', code);

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

    console.log('send %d bytes: %s', buf.length, buf);

    this.sock.write(buf);
};

DebugSession.prototype.parseCmdResult = function (data, callback /* (data: buffer) */) {
    var code = data.slice(0, 4).toString();

    if (code == 'OKAY') {
        console.log('exec command succeeded');

        this.parseData(data.slice(4), callback);
    } else if (code == 'FAIL') {
        console.log('exec command failed');

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

    console.log('found %d bytes data: %s', len, data.slice(4, 4+len));

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
        console.log('recv %d bytes data: %s', data.length, data);

        session.parseCmdResult(data, callback);
    });
};

DebugSession.prototype.recvData = function (callback /* (data: buffer) */) {
    this.sock.on('data', callback);
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

var adb = new DebugBridge();

adb.getVersion(function (version) {
    console.log('Android Debug Bridge version 1.0.%d', version);
});

adb.listDevices(function (devices) {
    console.log('found %d device %s', devices.length, devices);
});

adb.traceDevice(function (devices) {
    console.log('found %d device %s', devices.length, devices);

    for (var i=0; i<devices.length; i++) {
        var device = devices[i];

        device.takeSnapshot(function (frame) {
            console.log(frame.toString());

            frame.writeImageFile('snapshot.jpg');
        });
    }
});
