#!/usr/bin/env node
/*

Discover MQTT broker.
*/

// Try to shutup some of the annoying avahi warnings.
process.env['AVAHI_COMPAT_NOWARN'] = 1;

var events = require('events');
var util   = require('util');

var debug = require('debug')('mqtt-discover');
var mdns  = require('mdns');
var mqtt  = require('mqtt');


var MQTTDiscover = function (server_ip) {
    // Keep track of possible MQTT servers to connect to
    if (server_ip) {
        // if the user desires a specific server, they can select at module init
        this._possible_mqtt_servers = [server_ip];
    } else {
        this._possible_mqtt_servers = ['localhost'];
    }

    // Use this variable to direct flow in this script. Basically, we want to
    // wait on a new MQTT server being found if we aren't already connected.
    this._waiting_on_mqtt_address = false;

    // Find a server running an MQTT broker
    this._browser = mdns.createBrowser(mdns.tcp('mqtt'));
    this._browser.on('serviceUp', this.on_serviceUp.bind(this));
    this._browser.on('error', this.on_error.bind(this));
};

// We use the EventEmitter pattern to return parsed objects
util.inherits(MQTTDiscover, events.EventEmitter);

// Call .start() to find MQTT broker
MQTTDiscover.prototype.start = function () {
    this._browser.start();
    this.connect_to_mqtt_broker();
};

// Called on discovering a MQTT service
MQTTDiscover.prototype.on_serviceUp = function(service) {
    debug('Found possible MQTT Broker on ' + service.addresses[0]);

    service.addresses.forEach((address) => {
        debug('Found possible MQTT Broker on ' + address);

        // Check for IPv6 (AHHHH!!!!)
        if (address.indexOf(':') != -1) {
            address = '[' + address + ']';
        }

        this._possible_mqtt_servers.push(address);

        if (this._waiting_on_mqtt_address) {
            this._waiting_on_mqtt_address = false;
            this.connect_to_mqtt_broker();
        }
    });
};

MQTTDiscover.prototype.on_error = function (err) {
    debug('mDNS search error')
    debug(err);
};

MQTTDiscover.prototype.connect_to_mqtt_broker = function () {

    // Get a candidate
    var broker_address = this._possible_mqtt_servers.shift();

    // Make sure the array is not empty
    if (broker_address) {
        debug('Trying to connect to MQTT at ' + broker_address);

        // Connect to that MQTT broker
        var client = mqtt.connect('mqtt://' + broker_address, {connectTimeout: 10*1000});

        // Keep track of when we should give up and move on
        var offline_timer = null;

        // On connect we pass this found client up
        client.on('connect', () => {
            debug('Connected to MQTT at ' + broker_address);

            // Clear timeout if necessary
            if (offline_timer != null) {
                clearTimeout(offline_timer);
                offline_timer = null;
            }

            // Send this MQTT client connection to all listeners
            this.emit('mqttBroker', client);
        });

        // Check to see if there is actually an MQTT server to connect to
        client.on('offline', () => {
            // Setup a timer for when to give up, wait up to 10 seconds
            if (offline_timer == null) {
                debug("Offline, waiting for it to come back");

                var that = this;
                offline_timer = setTimeout(function() {
                    // Could not connect for some reason
                    debug('Could not connect to ' + broker_address);

                    // Stop trying to connect
                    client.end(true, () => {
                        debug('Stopped trying to connect to ' + broker_address);

                        // Try a new server
                        that.connect_to_mqtt_broker();
                    });
                }, 10*1000);
            }
        });

    } else {
        // Hmm, no MQTT servers to check. Wait and see if more appear
        this._waiting_on_mqtt_address = true;
    }
}

module.exports = new MQTTDiscover();
