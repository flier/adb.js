var DebugBridge = require('./adb.js').DebugBridge;

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