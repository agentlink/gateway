#!/usr/bin/env node

var iM880 = require('iM880-serial-comm');
var mqtt = require('mqtt');
var crc = require('crc');
var addr = require('os').networkInterfaces();

// Handle settings
var fs = require('fs');
var conf;
try {
  conf = fs.readFileSync('/etc/swarm-gateway/lora.json');
  conf = JSON.parse(conf);
} catch (err) {
  conf = {}
}
console.log(conf);

if ( ! ('device_id' in conf) ) {
  conf.device_id = 0x09;
}
if ( ! ('device_group' in conf) ) {
  conf.device_group = 0x10;
}
if ( ! ('serial_port' in conf) ) {
  conf.serial_port = '/dev/ttyUSB0';
}
if ( ! ('spreading_factor' in conf) ) {
  conf.spreading_factor = 7;
}
if ( ! ('bandwidth' in conf) ) {
  conf.bandwidth = 125000;
}
if ( ! ('stats_interval_milliseconds' in conf) ) {
  conf.stats_interval_milliseconds = 1000 * 10;
}
if ( ! ('mqtt_broker' in conf) ) {
  conf.mqtt_broker = 'localhost';
}
if ( ! ('rotate' in conf) ) {
  conf.rotate = true;
}

// Stats while running
var stats_start = Date.now();
var stats_lifetime = {};
var stats_lasttime = {};

//settings for rotating the different lora channels
SETTING_SWITCH_TIME_MINUTES = 2;
var lora_settings = [[7,125000],[8,125000],[9,125000],[10,125000],[8,500000]];

function stats_new_packet (buf) {
	var signpost_id = buf[5];
	var module = buf[6];
	var message_type = buf[7];

	if ( ! (signpost_id in stats_lifetime) ) {
		stats_lifetime[signpost_id] = {};
	}
	var life = stats_lifetime[signpost_id];
	if ( ! (signpost_id in stats_lasttime) ) {
		stats_lasttime[signpost_id] = {};
	}
	var last = stats_lasttime[signpost_id];

	var mod_mes = [module, message_type];
	if ( ! (mod_mes in life) ) {
		life[mod_mes] = 0;
	}
	life[mod_mes] += 1;
	if ( ! (mod_mes in last) ) {
		last[mod_mes] = 0;
	}
	last[mod_mes] += 1;
}

function stats_print_and_reset_last () {
	function print_signpost(stats, id) {
		console.log("    Signpost ID " + id);
		for (mod_mes in stats[id]) {
			// JS converts array -> string as object key
			var mod = parseInt(mod_mes.split(',')[0]);
			var mes = mod_mes.split(',')[1];
			console.log('\tMod 0x' + mod.toString(16) + ' Type ' + mes + ' - ' + stats[id][mod_mes])
		}
	}

	console.log("***********************************************************");
	var timediff = Date.now() - stats_start;
	var seconds = Math.round(timediff / 1000);
	console.log("Script lifetime - " + seconds + " seconds")
	for (signpost in stats_lifetime) {
		print_signpost(stats_lifetime, signpost);
	}
	console.log("Since last stats printing")
	for (signpost in stats_lasttime) {
		print_signpost(stats_lasttime, signpost);
	}
	console.log("***********************************************************");
	stats_lasttime = {};

	setTimeout(stats_print_and_reset_last, conf.stats_interval_milliseconds);
}

setTimeout(stats_print_and_reset_last, conf.stats_interval_milliseconds);

var mqtt_client = mqtt.connect('mqtt://' + conf.mqtt_broker);

// call the construction with and endpointID
var device = new iM880(
  conf.serial_port,
  conf.device_id,
  conf.device_group,
  conf.spreading_factor,
  conf.bandwidth);

// wait for config-done message and print endpointID
var msg = new Uint8Array([ 9, 8, 10, 67 ]);

device.on('config-done', function (statusmsg) {
  // Print the result of configuring the dongle
  console.log('Configuration status: ' + statusmsg);
  if(conf.rotate == true) {
    rotate_settings();
  }
});


function get_meta (src_addr) {
    if(addr.eth0) {
        return {
		received_time: new Date().toISOString(),
		device_id: src_addr,
		receiver: 'lora',
		gateway_id: addr.eth0[0].mac
	    }
    } else { 
        return {
		received_time: new Date().toISOString(),
		device_id: src_addr,
		receiver: 'lora',
		gateway_id: 'gateway1'
	    }
    }

	
}

function get_meta_no_addr () { 
    if(addr.eth0) {
        return {
		received_time: new Date().toISOString(),
		receiver: 'lora',
		gateway_id: addr.eth0[0].mac
	    }
    } else { 
        return {
		received_time: new Date().toISOString(),
		receiver: 'lora',
		gateway_id: 'gateway1'
	    }
    }
}

function pad (s, len) {
	for (var i=s.length; i<len; i++) {
		s = '0' + s;
	}
	return s;
}

var last_packets = {};

function parse (buf) {
	function check_duplicate (mod, msg_type, seq_no) {
		if (!(mod in last_packets)) {
			last_packets[mod] = {};
		}
		if (!(msg_type in last_packets[mod])) {
			last_packets[mod][msg_type] = seq_no-1;
		}

		var duplicate = true;
		if (seq_no != last_packets[mod][msg_type]) {
			duplicate = false;
		}

		last_packets[mod][msg_type] = seq_no;
		return duplicate;
	}


	// Strip out address
	var addr = '';
	for (var i=0; i<6; i++) {
		addr += pad(buf[i].toString(16), 2);
	}

	// Get the id (last address octet) of the sending signpost
	var signpost_id = buf[5];
	// Get the sender module
	var module = buf[6];
	// And the message type
	var message_type = buf[7];
	// And get the sequence number
	var sequence_number = buf[8];

	// Optionally filter packets
	if ( 'only_signpost_id' in conf ) {
		if (signpost_id != conf.only_signpost_id) {
			console.log("skip " + signpost_id);
			return;
		}
	}
	if ( 'only_module_id' in conf ) {
		if (module != conf.only_module_id) {
			console.log("modskip " + module + " - 0x" + module.toString(16));
			return;
		}
	}

	// DISCARD DUPLICATES BASED ON SEQ NUMBER
	/*var duplicate = check_duplicate(module, message_type, sequence_number);
	if (duplicate) {
		console.log('[' + module + ':'+ message_type +'] Duplicate (' + sequence_number + ')');
		return undefined;
	}*/

	// Update stats
	stats_new_packet(buf);

	if (module == 0x20) {
		// Controller
		if (message_type == 0x01) {
			// Energy
			var energy_module0 = buf.readUInt16BE(9);
			var energy_module1 = buf.readUInt16BE(11);
			var energy_module2 = buf.readUInt16BE(13);
			var energy_controller = buf.readUInt16BE(15);
			var energy_linux   = buf.readUInt16BE(17);
			var energy_module5 = buf.readUInt16BE(19);
			var energy_module6 = buf.readUInt16BE(21);
			var energy_module7 = buf.readUInt16BE(23);

			return {
				device: "signpost_energy_remaining",
                sequence_number: sequence_number,
				controller_energy_remaining_mWh: energy_controller,
				module0_energy_remaining_mWh: energy_module0,
				module1_energy_remaining_mWh: energy_module1,
				module2_energy_remaining_mWh: energy_module2,
				module5_energy_remaining_mWh: energy_module5,
				module6_energy_remaining_mWh: energy_module6,
				module7_energy_remaining_mWh: energy_module7,
				_meta: get_meta(addr)
			}
		} else if (message_type == 0x02) {
			// GPS
			var day = buf.readUInt8(9);
			var month = buf.readUInt8(10);
			var year = buf.readUInt8(11);
			var hours = buf.readUInt8(12);
			var minutes = buf.readUInt8(13);
			var seconds = buf.readUInt8(14);
			var latitude = buf.readInt32BE(15)/(10000*100.0);
			var longitude = buf.readInt32BE(19)/(10000*100.0);
			var fix = ['', 'No Fix', '2D', '3D'][buf.readUInt8(23)];
			var satellite_count = buf.readUInt8(24);

			if (year >= 80) {
			  year += 1900;
			} else {
			  year += 2000;
			}

			var latitude_direction = 'N';
			if (latitude < 0) {
			  latitude *= -1;
			  latitude_direction = 'S';
			}

			var longitude_direction = 'E';
			if (longitude < 0) {
			  longitude *= -1;
			  longitude_direction = 'W';
			}

			// that's right, month is zero-indexed for some reason
			var utcDate = new Date(Date.UTC(year, month-1, day, hours, minutes, seconds));

			return {
				device: 'signpost_gps',
                sequence_number: sequence_number,
				latitude: latitude,
				latitude_direction: latitude_direction,
				longitude: longitude,
				longitude_direction: longitude_direction,
				timestamp: utcDate.toISOString(),
                satellite_count: satellite_count,
				_meta: get_meta(addr)
			}
        } else if (message_type == 0x03) {
            var battery_voltage = buf.readUInt16BE(9);
            var battery_current = buf.readInt32BE(11);
            var solar_voltage = buf.readUInt16BE(15);
            var solar_current = buf.readInt32BE(17);
            var battery_percent = buf.readUInt8(21);
            var battery_energy = buf.readUInt16BE(22);
            var battery_capacity = buf.readUInt16BE(24);

            return {
                device: "signpost_bat_sol_status",
                sequence_number: sequence_number,
                battery_voltage_mV: battery_voltage,
                battery_current_uA: battery_current,
                solar_voltage_mV: solar_voltage,
                solar_current_uA: solar_current,
                battery_percent_remaining: battery_percent,
                battery_coulombs_remaining_mAh: battery_energy,
                battery_coulombs_full_mAh: battery_capacity,
                _meta: get_meta(addr)
            }
        } else if (message_type == 0x04) {
            // Energy
			var energy_module0 = buf.readUInt16BE(9);
			var energy_module1 = buf.readUInt16BE(11);
			var energy_module2 = buf.readUInt16BE(13);
			var energy_controller = buf.readUInt16BE(15);
			var energy_linux   = buf.readUInt16BE(17);
			var energy_module5 = buf.readUInt16BE(19);
			var energy_module6 = buf.readUInt16BE(21);
			var energy_module7 = buf.readUInt16BE(23);

			return {
				device: "signpost_average_power",
                sequence_number: sequence_number,
				controller_average_power_mW: energy_controller,
				module0_average_power_mW: energy_module0,
				module1_average_power_mW: energy_module1,
				module2_average_power_mW: energy_module2,
				module5_average_power_mW: energy_module5,
				module6_average_power_mW: energy_module6,
				module7_average_power_mW: energy_module7,
				_meta: get_meta(addr)
			}
        }
	} else if (module == 0x31) {
		if (message_type == 0x01) {
			var chan11 = buf.readInt8(9);
			var chan12 = buf.readInt8(10);
			var chan13 = buf.readInt8(11);
			var chan14 = buf.readInt8(12);
			var chan15 = buf.readInt8(13);
			var chan16 = buf.readInt8(14);
			var chan17 = buf.readInt8(15);
			var chan18 = buf.readInt8(16);
			var chan19 = buf.readInt8(17);
			var chan20 = buf.readInt8(18);
			var chan21 = buf.readInt8(19);
			var chan22 = buf.readInt8(20);
			var chan23 = buf.readInt8(21);
			var chan24 = buf.readInt8(22);
			var chan25 = buf.readInt8(23);
			var chan26 = buf.readInt8(24);

			console.log(buf);
			if (chan11 >= 0 ||
				chan12 >= 0 ||
				chan13 >= 0 ||
				chan14 >= 0 ||
				chan15 >= 0 ||
				chan16 >= 0 ||
				chan17 >= 0 ||
				chan18 >= 0 ||
				chan19 >= 0 ||
				chan20 >= 0 ||
				chan21 >= 0 ||
				chan22 >= 0 ||
				chan22 >= 0 ||
				chan23 >= 0 ||
				chan24 >= 0 ||
				chan25 >= 0 ||
				chan26 >= 0) {
				return undefined;
			}

			return {
				device: 'signpost_2.4ghz_spectrum',
                sequence_number: sequence_number,
				channel_11: chan11,
				channel_12: chan12,
				channel_13: chan13,
				channel_14: chan14,
				channel_15: chan15,
				channel_16: chan16,
				channel_17: chan17,
				channel_18: chan18,
				channel_19: chan19,
				channel_20: chan20,
				channel_21: chan21,
				channel_22: chan22,
				channel_23: chan23,
				channel_24: chan24,
				channel_25: chan25,
				channel_26: chan26,
				_meta: get_meta(addr)
			}
		}
	} else if (module == 0x32) {
		if (message_type == 0x01) {
                        var temp = buf.readInt16BE(9) / 100.0;
			var humi = buf.readInt16BE(11) / 100.0;
			var ligh = buf.readInt16BE(13);
			// app returns pressure in uBar in 3 bytes, left aligned
                        // pascal = 1x10^-5 Bar = 10 uBar
                        var pres = (buf.readInt32BE(15) >> 8) / 10.0;

			return {
				device: 'signpost_ambient',
                sequence_number: sequence_number,
				temperature_c: temp,
				humidity: humi,
				light_lux: ligh,
				pressure_pascals: pres,
				_meta: get_meta(addr)
			}
		}
    } else if (module == 0x33) {
		if (message_type == 0x01) {
            //these are in dB SPL! I simplified the math to some magic numbers
            //here's the rundown
            //output/4096*3.3 = vout
            //vout/2.82 = voutrms
            //voutdB = 20*log(voutrms/ref=-38dBV@SPL=0.0125Vrms)
            //voutmic = voutdB-(msgeq7gain+ampgain@100k=58.5dB)
            //voutmic+94dB SPL = outdB @spl
            //reduces to
            //(20*log(output/43.75))+35.5
            //for right now this is happening here, but I'm trying to move it
            //to the app itself
			var f_63_hz = Number(((Math.log10(buf.readUInt16BE(9)/43.75)*20)+35.5).toFixed(0));
			var f_160_hz = Number(((Math.log10(buf.readUInt16BE(11)/43.75)*20)+35.5).toFixed(0));
			var f_400_hz = Number(((Math.log10(buf.readUInt16BE(13)/43.75)*20)+35.5).toFixed(0));
			var f_1000_hz = Number(((Math.log10(buf.readUInt16BE(15)/43.75)*20)+35.5).toFixed(0));
			var f_2500_hz = Number(((Math.log10(buf.readUInt16BE(17)/43.75)*20)+35.5).toFixed(0));
			var f_6250_hz = Number(((Math.log10(buf.readUInt16BE(19)/43.75)*20)+35.5).toFixed(0));
			var f_16000_hz = Number(((Math.log10(buf.readUInt16BE(21)/43.75)*20)+35.5).toFixed(0));

			return {
			    device: 'signpost_audio_frequency',
                sequence_number: sequence_number,
                "63Hz": f_63_hz,
                '160Hz': f_160_hz,
                '400Hz': f_400_hz,
                '1000Hz': f_1000_hz,
                '2500Hz': f_2500_hz,
                '6250Hz': f_6250_hz,
                '16000Hz': f_16000_hz,
			    _meta: get_meta(addr)
			}
		}
	} else if (module == 0x34) {
		if (message_type == 0x01) {
			var motion = buf.readInt8(9) > 0;
			var speed = buf.readUInt32BE(10) / 1000.0;
			var motion_confidence = buf.readUInt8(14);

			return {
				device: 'signpost_microwave_radar',
                sequence_number: sequence_number,
				motion: motion,
				'velocity_m/s': speed,
                'motion_confidence': motion_confidence,
				_meta: get_meta(addr)
			}
		}
	} else if (module == 0x35) {
		if (message_type == 0x01) {
			var co2_ppm = buf.readUInt16BE(9);
			var VOC_PID_ppb = buf.readUInt32BE(11);
			var VOC_IAQ_ppb = buf.readUInt32BE(15);
			var barometric_millibar = buf.readUInt16BE(19);
			var humidity_percent = buf.readUInt16BE(21);
			return {
				device: 'signpost_ucsd_air_quality',
                sequence_number: sequence_number,
				co2_ppm: co2_ppm,
				VOC_PID_ppb: VOC_PID_ppb,
				VOC_IAQ_ppb: VOC_IAQ_ppb,
				barometric_millibar: barometric_millibar,
				humidity_percent: humidity_percent,
				_meta: get_meta(addr)
			}
		}
	} else if (module == 0x22) {
		if (message_type == 0x01) {
            var controller = 0;
            var audio = 0;
            var microwave = 0;
            var rf = 0;
            var ambient = 0;
            var radio = 0;
            var ucsd = 0;
        
            var num_mods = buf.readUInt8(9);
            j = 0;
            for(; j < num_mods; j++) { 
                switch(buf.readUInt8(10+j*2)) {
                    case 0x20:
                        controller = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x22:
                        radio = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x31:
                        rf = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x32:
                        ambient = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x33:
                        audio = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x34:
                        microwave = buf.readUInt8(10+j*2+1);
                    break;
                    case 0x34:
                        ucsd = buf.readUInt8(10+j*2+1);
                    break;
                }
            }
            
            queue_size = buf.readUInt8(10+j*2);

			return {
                //energy estimations on mWh/packet. packetcount*(ble/pack+lora/pack)
			    device: 'signpost_radio_status',
                sequence_number: sequence_number,
                "controller_lora_packets_sent": controller,
                "2.4gHz_spectrum_lora_packets_sent": rf,
                "ambient_sensing_lora_packets_sent": ambient,
                "audio_spectrum_lora_packets_sent": audio,
                "microwave_radar_lora_packets_sent": microwave,
                "ucsd_air_quality_lora_packets_sent": ucsd,
                "radio_status_lora_packets_sent": radio,
                "controller_radio_energy_used_mWh": Number(controller*(0.000096+0.01)).toFixed(3),
                "2.4gHz_spectrum_radio_energy_used_mWh":Number(rf*(0.000096+0.01)).toFixed(3),
                "ambient_sensing_radio_energy_used_mWh":Number(ambient*(0.000096+0.01)).toFixed(3),
                "audio_spectrum_radio_energy_used_mWh":Number(audio*(0.000096+0.01)).toFixed(3),
                "microwave_radar_radio_energy_used_mWh":Number(microwave*(0.000096+0.01)).toFixed(3),
                "ucsd_air_quality_radio_energy_used_mWh":Number(ucsd*(0.000096+0.01)).toFixed(3),
                "radio_status_radio_energy_used_mWh":Number(radio*(0.000096+0.01)).toFixed(3),
                "radio_queue_length": queue_size,
			    _meta: get_meta(addr)
			}
		}
        if (message_type == 0x02) {

			return {
			    device: 'signpost_radio_test_packet',
                sequence_number: sequence_number,
			    _meta: get_meta(addr)
			}
	    }
    }
}

// listen for new messages and print them
device.on('rx-msg', function(data) {
	// print rx message without slip encoding or checksum
	var buf = new Buffer(data.payload);
        var recvcrc = buf.readUInt16BE(buf.length - 2);
        var calccrc = crc.crc16ccitt(buf.slice(0, buf.length - 2));
        var pkt;
        if (recvcrc !== calccrc) {
            console.log('crc check failed')
            console.log('received:\t0x'+recvcrc.toString(16));
            console.log('calculated:\t0x'+calccrc.toString(16));
            pkt =
            {
                device: 'crc_check_failed',
                buffer: buf.toString('hex'),
                received_crc: recvcrc,
                calculated_crc: calccrc,
                _meta: get_meta_no_addr()
            }
        }
        else {
            pkt = parse(buf);
            console.log('crc check succeeded')
        }
	if (pkt !== undefined) {
        pkt._meta.spreading_factor =  conf.spreading_factor,
        pkt._meta.bandwidth = conf.bandwidth,
        pkt.snr_db = data.snr,
        pkt.rssi_dbm = data.rssi
        console.log(pkt);
		mqtt_client.publish('gateway-data', JSON.stringify(pkt));
		mqtt_client.publish('signpost', JSON.stringify(pkt));
	}
});

function rotate_settings() {

    var d = new Date();

    //account for leap seconds to sync with radio
    var epoch = d.getTime() + 3000;

    var secondsSinceLastTrigger = epoch % (SETTING_SWITCH_TIME_MINUTES * 60000);
    var secondsUntilNextTrigger = (SETTING_SWITCH_TIME_MINUTES * 60000) - secondsSinceLastTrigger;
    
    setTimeout(function() {
        //calculate the setting index based on the time
        var now = new Date();
        var mins = now.getMinutes();
        //plus one to account for gps time
        var setting_index = ((mins+1)/SETTING_SWITCH_TIME_MINUTES) % lora_settings.length;

        //set the settings
        conf.spreading_factor = lora_settings[setting_index][0];
        conf.bandwidth = lora_settings[setting_index][1];

        console.log("Rotating settings to sf: " + conf.spreading_factor + " bandwidth: " + conf.bandwidth);
        device.configure(conf.device_id,conf.device_group,conf.spreading_factor,conf.bandwidth);

    }, secondsUntilNextTrigger);
}
