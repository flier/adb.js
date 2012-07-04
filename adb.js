var console = require('console');
var net = require('net');
var util = require('util');

var DebugBridge = exports.DebugBridge = function () {
    if (!DebugBridge.initialized) {
        DebugBridge.initialize();
        DebugBridge.initialized = true;
    }

    this.autoStartDaemon = true;
};

var DebugSession = function (adb, sock) {
    this.adb = adb;
    this.sock = sock;
};

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
        console.log('client connected %s:%d', sock.remoteAddress, sock.remotePort);

        callback(new DebugSession(adb, sock));
    });

    sock.setNoDelay(true);
    sock.on('end', function () {
        console.log('client disconnected');

        sock.end();
    });
    sock.on('timeout', function () {
        console.log('client timeout');
    });
    sock.on('error', function (err) {
        if ('ECONNREFUSED' == err.errno) {
            console.log('client connect refused, restarting adb daemon...');

            if (this.autoStartDaemon) {
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
        var c = (len >> 4*i) & 0xF;
        buf += '0123456789ABCDEF'.charAt(c);
    }

    return buf;
}

function decodeNumber(str) {
    var num = 0;

    for (var i=0; i<str.length; i++) {
        var c = '0123456789ABCDEF'.indexOf(String.fromCharCode(str[i]).toUpperCase());

        num = num * 16 + c;
    }

    return num;
}

DebugSession.prototype.sendData = function (data) {
    console.log(data + ',' + typeof(data) + data.length + ',' + encodeNumber(data.length));
    var buf = encodeNumber(data.length) + data;

    console.log('send %d bytes: %s', buf.length, buf);

    this.sock.write(buf);
};

DebugSession.prototype.parseData = function (data, callback /* (data: buffer) */) {
    var len = decodeNumber(data.slice(0, 4));

    console.log('found %d bytes data: %s', len, data.slice(4, 4+len));

    if (data.length < len+4) {
        // TODO wait for the remaining data
    } else {
        callback(data.slice(4, 4+len));

        if (data.length > 4+len) {
            adb.recvData(data.slice(4+len), callback);
        }
    }
};

DebugSession.prototype.recvData = function (callback /* (data: buffer) */) {
    var adb = this;

    this.sock.on('data', function (data) {
        console.log('recv %d bytes: %s', data.length, data);

        var code = data.slice(0, 4).toString();

        if (code == 'OKAY') {
            console.log('exec command succeeded');

            adb.parseData(data.slice(4), callback);
        } else if (code == 'FAIL') {
            console.log('exec command failed');

            adb.parseData(data.slice(4), function (msg) {
                throw new Error(msg);
            });
        } else {
            adb.parseData(data, callback)
        }
    });
};

DebugBridge.prototype.execCommand = function (cmd, callback /* (data: buffer) */) {
    this.connect(function (session) {
        session.recvData(callback);
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
    });
};

var AndroidDevice = exports.AndroidDevice = function (adb, id, type) {
    this.adb = adb;
    this.id = id;
    this.type = type;
};

AndroidDevice.LOCAL_CLIENT_PREFIX = "emulator-";

AndroidDevice.prototype.toString = function () {
    return util.format('<%s %s>', this.type, this.id);
};

Object.defineProperty(AndroidDevice.prototype, 'isEmulator', {
    get: function () {
        return this.id.indexOf(AndroidDevice.LOCAL_CLIENT_PREFIX) == 0;
    }
});

var adb = new DebugBridge();

adb.getVersion(function (version) {
    console.log('Android Debug Bridge version 1.0.%d', version);
});
adb.listDevices(function (devices) {
    console.log('found %d device %s', devices.length, devices);
});

adb.traceDevice(function (devices) {
    console.log('found %d device %s', devices.length, devices);
});