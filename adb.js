var console = require('console');
var net = require('net');
var util = require('util');

var DebugBridge = exports.DebugBridge = function () {
    if (!DebugBridge.initialized) {
        DebugBridge.initialize();
        DebugBridge.initialized = true;
    }
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

DebugBridge.start_server = function (callback) {
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

DebugBridge.prototype.connect = function (callback) {
    var adb = this;

    adb.sock = net.connect({ port: DebugBridge.DEFAULT_PORT }, function () {
        console.log('client connected %s:%d', adb.sock.remoteAddress, adb.sock.remotePort);

        callback(adb);
    });

    adb.sock.setNoDelay(true);
    adb.sock.on('end', function () {
        console.log('client disconnected');

        adb.sock.end();
    });
    adb.sock.on('timeout', function () {
        console.log('client timeout');
    });
    adb.sock.on('error', function (err) {
        if ('ECONNREFUSED' == err.errno) {
            console.log('client connect refused, restarting adb daemon...');

            DebugBridge.start_server(function (code) {
                console.log('start adb daemon: %d', code);

                if (code == 0) {
                    adb.connect(callback);
                }
            });
        } else {
            console.error('client caught exception: ' + err);
        }
    });
};

function encodeNumber(len) {
    var buf = '';

    for (var i=3; i>=0; i--) {
        var c = (len >> 8*i) & 0xF;
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

DebugBridge.prototype.sendData = function (data) {
    var buf = encodeNumber(data.length) + data;

    console.log('send %d bytes: %s', buf.length, buf);

    this.sock.write(buf);
};

DebugBridge.prototype.parseData = function (data, callback) {
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

DebugBridge.prototype.recvData = function (callback) {
    var adb = this;

    this.sock.once('data', function (data) {
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

DebugBridge.prototype.execCommand = function (cmd, callback) {
    this.recvData(callback);
    this.sendData(cmd);
};

DebugBridge.prototype.getVersion = function (callback) {
    console.log('getting version');

    this.execCommand('host:version', function (data) {
        callback(decodeNumber(data));
    });
};

var adb = new DebugBridge();

adb.connect(function (adb) {
    adb.getVersion(function (version) {
        console.log('Android Debug Bridge version 1.0.%d', version);
    });
});