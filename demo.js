var DebugBridge = require('./adb.js').DebugBridge;

var adb = new DebugBridge();
/*
adb.getVersion(function (version) {
    console.log('Android Debug Bridge version 1.0.%d', version);
});

adb.listDevices(function (devices) {
    console.log('found %d device %s', devices.length, devices);
});
*/
adb.traceDevice(function (devices) {
    console.log('found %d device %s', devices.length, devices);

    for (var i=0; i<devices.length; i++) {
        var device = devices[i];
        /*
        device.takeSnapshot(function (frame) {
            frame.writeImageFile('snapshot.jpg');
        });
        */
        device.getSyncService(function (svc) {
            svc.pullFile('/system/framework/framework.odex', './framework.odex', function (size) {
                console.log("pull %d bytes file", size);
            });
        });
    }
});