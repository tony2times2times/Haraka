"use strict";

var util         = require('util');
var events       = require('events');
var fs           = require('fs');
var dns          = require('dns');

var generic_pool = require('generic-pool');
var Address     = require('address-rfc2821').Address;

var constants   = require('haraka-constants');
var net_utils   = require('haraka-net-utils');
var utils       = require('haraka-utils');

var sock        = require('../line_socket');
var logger      = require('../logger');
var config      = require('../config');
var plugins     = require('../plugins');
var Header      = require('../mailheader').Header;
var DSN         = require('../dsn');
var server      = require('../server');

/////////////////////////////////////////////////////////////////////////////
// HMailItem - encapsulates an individual outbound mail item

var dummy_func = function () {};


function HMailItem (filename, filePath, notes) {
    events.EventEmitter.call(this);
    var parts = _qfile.parts(filename);
    if (!parts) {
        throw new Error("Bad filename: " + filename);
    }
    this.path         = filePath;
    this.filename     = filename;
    this.next_process = parts.next_attempt;
    this.num_failures = parts.attempts;
    this.pid          = parts.pid;
    this.notes        = notes || {};
    this.refcount     = 1;
    this.todo         = null;
    this.file_size    = 0;
    this.next_cb      = dummy_func;
    this.bounce_error = null;
    this.hook         = null;
    this.size_file();
}

util.inherits(HMailItem, events.EventEmitter);

module.exports = HMailItem;


logger.add_log_methods(HMailItem.prototype, "outbound");

HMailItem.prototype.data_stream = function () {
    return fs.createReadStream(this.path, {start: this.data_start, end: this.file_size});
};

HMailItem.prototype.size_file = function () {
    var self = this;
    fs.stat(self.path, function (err, stats) {
        if (err) {
            // we are fucked... guess I need somewhere for this to go
            self.logerror("Error obtaining file size: " + err);
            self.temp_fail("Error obtaining file size");
        }
        else {
            self.file_size = stats.size;
            self.read_todo();
        }
    });
};

HMailItem.prototype.read_todo = function () {
    var self = this;
    var tl_reader = fs.createReadStream(self.path, {start: 0, end: 3});
    tl_reader.on('error', function (err) {
        self.logerror("Error reading queue file: " + self.path + ": " + err);
        return self.temp_fail("Error reading queue file: " + err);
    });
    tl_reader.once('data', function (buf) {
        // I'm making the assumption here we won't ever read less than 4 bytes
        // as no filesystem on the planet should be that dumb...
        tl_reader.destroy();
        var todo_len = (buf[0] << 24) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
        var td_reader = fs.createReadStream(self.path, {encoding: 'utf8', start: 4, end: todo_len + 3});
        self.data_start = todo_len + 4;
        var todo = '';
        td_reader.on('data', function (str) {
            todo += str;
            if (Buffer.byteLength(todo) === todo_len) {
                // we read everything
                self.todo = JSON.parse(todo);
                self.todo.rcpt_to = self.todo.rcpt_to.map(function (a) { return new Address (a); });
                self.todo.mail_from = new Address (self.todo.mail_from);
                self.emit('ready');
            }
        });
        td_reader.on('end', function () {
            if (Buffer.byteLength(todo) !== todo_len) {
                self.logcrit("Didn't find right amount of data in todo!");
                fs.rename(self.path, path.join(queue_dir, "error." + self.filename), function (err) {
                    if (err) {
                        self.logerror("Error creating error file after todo read failure (" + self.filename + "): " + err);
                    }
                });
                self.emit('error', "Didn't find right amount of data in todo!"); // Note nothing picks this up yet
            }
        });
    });
};

HMailItem.prototype.send = function () {
    if (cfg.disabled) {
        // try again in 1 second if delivery is disabled
        this.logdebug("delivery disabled temporarily. Retrying in 1s.");
        var hmail = this;
        setTimeout(function () { hmail.send(); }, 1000);
        return;
    }

    if (!this.todo) {
        var self = this;
        this.once('ready', function () { self._send(); });
    }
    else {
        this._send();
    }
};

HMailItem.prototype._send = function () {
    plugins.run_hooks('send_email', this);
};

HMailItem.prototype.send_email_respond = function (retval, delay_seconds) {
    if (retval === constants.delay) {
        // Try again in 'delay' seconds.
        this.logdebug("Delivery of this email delayed for " + delay_seconds + " seconds");
        var hmail = this;
        hmail.next_cb();
        temp_fail_queue.add(delay_seconds * 1000, function () { delivery_queue.push(hmail); });
    }
    else {
        this.logdebug("Sending mail: " + this.filename);
        this.get_mx();
    }
};

HMailItem.prototype.get_mx = function () {
    var domain = this.todo.domain;

    plugins.run_hooks('get_mx', this, domain);
};

HMailItem.prototype.get_mx_respond = function (retval, mx) {
    var hmail = this;
    switch (retval) {
        case constants.ok:
            var mx_list;
            if (Array.isArray(mx)) {
                mx_list = mx;
            }
            else if (typeof mx === "object") {
                mx_list = [mx];
            }
            else {
                // assume string
                var matches = /^(.*?)(:(\d+))?$/.exec(mx);
                if (!matches) {
                    throw ("get_mx returned something that doesn't match hostname or hostname:port");
                }
                mx_list = [{priority: 0, exchange: matches[1], port: matches[3]}];
            }
            this.logdebug("Got an MX from Plugin: " + this.todo.domain + " => 0 " + mx);
            return this.found_mx(null, mx_list);
        case constants.deny:
            this.logwarn("get_mx plugin returned DENY: " + mx);
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("No MX for " + hmail.domain));
            });
            return this.bounce("No MX for " + this.domain);
        case constants.denysoft:
            this.logwarn("get_mx plugin returned DENYSOFT: " + mx);
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("Temporary MX lookup error for " + hmail.domain, 450));
            });
            return this.temp_fail("Temporary MX lookup error for " + this.domain);
    }

    // if none of the above return codes, drop through to this...
    mx.lookup_mx(this.todo.domain, function (err, mxs) {
        hmail.found_mx(err, mxs);
    });
};


HMailItem.prototype.found_mx = function (err, mxs) {
    var hmail = this;
    if (err) {
        this.logerror("MX Lookup for " + this.todo.domain + " failed: " + err);
        if (err.code === dns.NXDOMAIN || err.code === dns.NOTFOUND) {
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("No Such Domain: " + hmail.todo.domain));
            });
            this.bounce("No Such Domain: " + this.todo.domain);
        }
        else if (err.code === 'NOMX') {
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("Nowhere to deliver mail to for domain: " + hmail.todo.domain));
            });
            this.bounce("Nowhere to deliver mail to for domain: " + hmail.todo.domain);
        }
        else {
            // every other error is transient
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_unspecified("DNS lookup failure: " + hmail.todo.domain));
            });
            this.temp_fail("DNS lookup failure: " + err);
        }
    }
    else {
        // got MXs
        var mxlist = sort_mx(mxs);
        // support draft-delany-nullmx-02
        if (mxlist.length === 1 && mxlist[0].priority === 0 && mxlist[0].exchange === '') {
            this.todo.rcpt_to.forEach(function (rcpt) {
                hmail.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("Domain " + hmail.todo.domain + " sends and receives no email (NULL MX)"));
            });
            return this.bounce("Domain " + this.todo.domain + " sends and receives no email (NULL MX)");
        }
        // duplicate each MX for each ip address family
        this.mxlist = [];
        for (var mx in mxlist) {
            if (cfg.ipv6_enabled) {
                this.mxlist.push(
                    { exchange: mxlist[mx].exchange, priority: mxlist[mx].priority, port: mxlist[mx].port, using_lmtp: mxlist[mx].using_lmtp, family: 'AAAA' },
                    { exchange: mxlist[mx].exchange, priority: mxlist[mx].priority, port: mxlist[mx].port, using_lmtp: mxlist[mx].using_lmtp, family: 'A' }
                );
            }
            else {
                mxlist[mx].family = 'A';
                this.mxlist.push(mxlist[mx]);
            }
        }
        this.try_deliver();
    }
};

// MXs must be sorted by priority order, but matched priorities must be
// randomly shuffled in that list, so this is a bit complex.
function sort_mx (mx_list) {
    var sorted = mx_list.sort(function (a,b) {
        return a.priority - b.priority;
    });

    // This isn't a very good shuffle but it'll do for now.
    for (var i=0,l=sorted.length-1; i<l; i++) {
        if (sorted[i].priority === sorted[i+1].priority) {
            if (Math.round(Math.random())) { // 0 or 1
                var j = sorted[i];
                sorted[i] = sorted[i+1];
                sorted[i+1] = j;
            }
        }
    }
    return sorted;
}

HMailItem.prototype.try_deliver = function () {
    var self = this;

    // check if there are any MXs left
    if (this.mxlist.length === 0) {
        this.todo.rcpt_to.forEach(function (rcpt) {
            self.extend_rcpt_with_dsn(rcpt, DSN.addr_bad_dest_system("Tried all MXs" + self.todo.domain));
        });
        return this.temp_fail("Tried all MXs");
    }

    var mx   = this.mxlist.shift();
    var host = mx.exchange;

    // IP or IP:port
    if (net.isIP(host)) {
        self.hostlist = [ host ];
        return self.try_deliver_host(mx);
    }

    host   = mx.exchange;
    var family = mx.family;

    this.loginfo("Looking up " + family + " records for: " + host);

    // we have a host, look up the addresses for the host
    // and try each in order they appear
    // IS: IPv6 compatible
    dns.resolve(host, family, function (err, addresses) {
        if (err) {
            self.logerror("DNS lookup of " + host + " failed: " + err);
            return self.try_deliver(); // try next MX
        }
        if (addresses.length === 0) {
            // NODATA or empty host list
            self.logerror("DNS lookup of " + host + " resulted in no data");
            return self.try_deliver(); // try next MX
        }
        self.hostlist = addresses;
        self.try_deliver_host(mx);
    });
};

var smtp_regexp = /^(\d{3})([ -])(?:(\d\.\d\.\d)\s)?(.*)/;

var cram_md5_response = function (username, password, challenge) {
    var crypto = require('crypto');
    var c = utils.unbase64(challenge);
    var hmac = crypto.createHmac('md5', password);
    hmac.update(c);
    var digest = hmac.digest('hex');
    return utils.base64(username + ' ' + digest);
}

function _create_socket (port, host, local_addr, is_unix_socket, connect_timeout, pool_timeout, callback) {
    var socket = is_unix_socket ? sock.connect({path: host}) :
        sock.connect({port: port, host: host, localAddress: local_addr});
    socket.setTimeout(connect_timeout * 1000);
    logger.logdebug('[outbound] host=' +
        host + ' port=' + port + ' pool_timeout=' + pool_timeout + ' created');
    socket.once('connect', function () {
        socket.removeAllListeners('error'); // these get added after callback
        callback(null, socket);
    });
    socket.once('error', function (err) {
        socket.end();
        var name = 'outbound::' + port + ':' + host + ':' + local_addr + ':' + pool_timeout;
        if (server.notes.pool[name]) {
            delete server.notes.pool[name];
        }
        callback("Outbound connection error: " + err, null);
    });
    socket.once('timeout', function () {
        socket.end();
        callback("Outbound connection timed out to " + host + ":" + port, null);
    });
}

// Separate pools are kept for each set of server attributes.
function get_pool (port, host, local_addr, is_unix_socket, connect_timeout, pool_timeout, max) {
    port = port || 25;
    host = host || 'localhost';
    connect_timeout = (connect_timeout === undefined) ? 30 : connect_timeout;
    var name = 'outbound::' + port + ':' + host + ':' + local_addr + ':' + pool_timeout;
    if (!server.notes.pool) {
        server.notes.pool = {};
    }
    if (!server.notes.pool[name]) {
        var pool = generic_pool.Pool({
            name: name,
            create: function (done) {
                _create_socket(port, host, local_addr, is_unix_socket, connect_timeout, pool_timeout, done);
            },
            validate: function (socket) {
                return socket.writable;
            },
            destroy: function (socket) {
                logger.logdebug('[outbound] destroying pool entry for ' + host + ':' + port);
                // Remove pool object from server notes once empty
                var size = pool.getPoolSize();
                if (size === 0) {
                    delete server.notes.pool[name];
                }
                socket.removeAllListeners();
                socket.once('error', function (err) {
                    logger.logwarn("[outbound] Socket got an error while shutting down: " + err);
                });
                if (!socket.writable) return;
                logger.logprotocol("[outbound] C: QUIT");
                socket.write("QUIT\r\n");
                socket.end(); // half close
                socket.once('line', function (line) {
                    // Just assume this is a valid response
                    logger.logprotocol("[outbound] S: " + line);
                    socket.destroy();
                });
            },
            max: max || 10,
            idleTimeoutMillis: pool_timeout * 1000,
            log: function (str, level) {
                if (/this._availableObjects.length=/.test(str)) return;
                level = (level === 'verbose') ? 'debug' : level;
                logger['log' + level]('[outbound] [' + name + '] ' + str);
            }
        });
        server.notes.pool[name] = pool;
    }
    return server.notes.pool[name];
}

// Get a socket for the given attributes.
function get_client (port, host, local_addr, is_unix_socket, callback) {
    if (cfg.pool_concurrency_max == 0) {
        return _create_socket(port, host, local_addr, is_unix_socket, cfg.connect_timeout, cfg.pool_timeout, callback);
    }

    var pool = get_pool(port, host, local_addr, is_unix_socket, cfg.connect_timeout, cfg.pool_timeout, cfg.pool_concurrency_max);
    if (pool.waitingClientsCount() >= cfg.pool_concurrency_max) {
        return callback("Too many waiting clients for pool", null);
    }
    pool.acquire(function (err, socket) {
        if (err) return callback(err);
        socket.__acquired = true;
        callback(null, socket);
    });
}

function release_client (socket, port, host, local_addr, error) {
    logger.logdebug("[outbound] release_client: " + host + ":" + port + " to " + local_addr);

    if (cfg.pool_concurrency_max == 0) {
        return sockend();
    }

    if (!socket.__acquired) {
        logger.logerror("Release an un-acquired socket. Stack: " + (new Error()).stack);
        return;
    }
    socket.__acquired = false;

    var pool_timeout = cfg.pool_timeout;
    var name = 'outbound::' + port + ':' + host + ':' + local_addr + ':' + pool_timeout;
    if (!(server.notes && server.notes.pool)) {
        logger.logcrit("[outbound] Releasing a pool (" + name + ") that doesn't exist!");
        return;
    }
    var pool = server.notes.pool[name];
    if (!pool) {
        logger.logcrit("[outbound] Releasing a pool (" + name + ") that doesn't exist!");
        return;
    }

    if (error) {
        return sockend();
    }

    if (cfg.pool_timeout == 0) {
        logger.loginfo("[outbound] Pool_timeout is zero - shutting it down");
        return sockend();
    }

    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    socket.removeAllListeners('end');
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('line');

    socket.__fromPool = true;

    socket.once('error', function (err) {
        logger.logwarn("[outbound] Socket [" + name + "] in pool got an error: " + err);
        sockend();
    });

    socket.once('end', function () {
        logger.logwarn("[outbound] Socket [" + name + "] in pool got FIN");
        sockend();
    });

    pool.release(socket);

    function sockend () {
        if (server.notes.pool[name]) {
            server.notes.pool[name].destroy(socket);
        }
        socket.removeAllListeners();
        socket.destroy();
    }
}

HMailItem.prototype.try_deliver_host = function (mx) {
    var self = this;

    if (self.hostlist.length === 0) {
        return self.try_deliver(); // try next MX
    }

    // Allow transaction notes to set outbound IP
    if (!mx.bind && self.todo.notes.outbound_ip) {
        mx.bind = self.todo.notes.outbound_ip;
    }

    // Allow transaction notes to set outbound IP helo
    if (!mx.bind_helo){
        if (self.todo.notes.outbound_helo) {
            mx.bind_helo = self.todo.notes.outbound_helo;
        }
        else {
            mx.bind_helo = config.get('me');
        }
    }

    var host = self.hostlist.shift();
    var port = mx.port || 25;

    if (mx.path) {
        host = mx.path;
    }

    this.loginfo("Attempting to deliver to: " + host + ":" + port +
        (mx.using_lmtp ? " using LMTP" : "") + " (" + delivery_queue.length() +
        ") (" + temp_fail_queue.length() + ")");

    get_client(port, host, mx.bind, mx.path ? true : false, function (err, socket) {
        if (err) {
            logger.logerror('[outbound] Failed to get pool entry: ' + err);
            // try next host
            return self.try_deliver_host(mx);
        }
        self.try_deliver_host_on_socket(mx, host, port, socket);
    });
}

HMailItem.prototype.try_deliver_host_on_socket = function (mx, host, port, socket) {
    var self            = this;
    var processing_mail = true;

    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.removeAllListeners('end');

    socket.once('error', function (err) {
        if (processing_mail) {
            self.logerror("Ongoing connection failed to " + host + ":" + port + " : " + err);
            processing_mail = false;
            release_client(socket, port, host, mx.bind, true);
            // try the next MX
            return self.try_deliver_host(mx);
        }
    });

    socket.once('close', function () {
        if (processing_mail) {
            self.logerror("Remote end " + host + ":" + port + " closed connection while we were processing mail. Trying next MX.");
            processing_mail = false;
            release_client(socket, port, host, mx.bind, true);
            return self.try_deliver_host(mx);
        }
    });

    var fin_sent = false;
    socket.once('end', function () {
        fin_sent = true;
    });

    var command = mx.using_lmtp ? 'connect_lmtp' : 'connect';
    var response = [];

    var recip_index = 0;
    var recipients = this.todo.rcpt_to;
    var lmtp_rcpt_idx = 0;

    var last_recip = null;
    var ok_recips = [];
    var fail_recips = [];
    var bounce_recips = [];
    var secured = false;
    var authenticating = false;
    var authenticated = false;
    var smtp_properties = {
        "tls": false,
        "max_size": 0,
        "eightbitmime": false,
        "enh_status_codes": false,
        "auth": [],
    };

    var tls_cfg = net_utils.load_tls_ini();

    var send_command = socket.send_command = function (cmd, data) {
        if (!socket.writable) {
            self.logerror("Socket writability went away");
            if (processing_mail) {
                processing_mail = false;
                release_client(socket, port, host, mx.bind, true);
                return self.try_deliver_host(mx);
            }
            return;
        }
        var line = cmd + (data ? (' ' + data) : '');
        if (cmd === 'dot' || cmd === 'dot_lmtp') {
            line = '.';
        }
        if (authenticating) cmd = 'auth';
        self.logprotocol("C: " + line);
        socket.write(line + "\r\n");
        command = cmd.toLowerCase();
        response = [];
    };

    var process_ehlo_data = function () {
        for (var i=0,l=response.length; i < l; i++) {
            var r = response[i];
            if (r.toUpperCase() === '8BITMIME') {
                smtp_properties.eightbitmime = true;
            }
            else if (r.toUpperCase() === 'STARTTLS') {
                smtp_properties.tls = true;
            }
            else if (r.toUpperCase() === 'ENHANCEDSTATUSCODES') {
                smtp_properties.enh_status_codes = true;
            }
            else {
                var matches;
                // Check for SIZE parameter and limit
                matches = r.match(/^SIZE\s+(\d+)$/);
                if (matches) {
                    smtp_properties.max_size = matches[1];
                }
                // Check for AUTH
                matches = r.match(/^AUTH\s+(.+)$/);
                if (matches) {
                    smtp_properties.auth = matches[1].split(/\s+/);
                }
            }
        }

        // TLS
        if (!net_utils.ip_in_list(tls_cfg.no_tls_hosts, self.todo.domain) &&
            !net_utils.ip_in_list(tls_cfg.no_tls_hosts, host) &&
            smtp_properties.tls && cfg.enable_tls && !secured)
        {
            socket.on('secure', function () {
                // Set this flag so we don't try STARTTLS again if it
                // is incorrectly offered at EHLO once we are secured.
                secured = true;
                send_command(mx.using_lmtp ? 'LHLO' : 'EHLO', mx.bind_helo);
            });
            return send_command('STARTTLS');
        }

        // IMPORTANT: we do STARTTLS before we attempt AUTH for extra security
        if (!authenticated && (mx.auth_user && mx.auth_pass)) {
            // We have AUTH credentials to send for this domain
            if (!(Array.isArray(smtp_properties.auth) && smtp_properties.auth.length)) {
                // AUTH not offered
                self.logwarn('AUTH configured for domain ' + self.todo.domain +
                             ' but host ' + host + ' did not advertise AUTH capability');
                // Try and send the message without authentication
                return send_command('MAIL', 'FROM:' + self.todo.mail_from);
            }

            if (!mx.auth_type) {
                // User hasn't specified an authentication type, so we pick one
                // We'll prefer CRAM-MD5 as it's the most secure that we support.
                if (smtp_properties.auth.indexOf('CRAM-MD5') !== -1) {
                    mx.auth_type = 'CRAM-MD5';
                }
                // PLAIN requires less round-trips compared to LOGIN
                else if (smtp_properties.auth.indexOf('PLAIN') !== -1) {
                    // PLAIN requires less round trips compared to LOGIN
                    // So we'll make this our 2nd pick.
                    mx.auth_type = 'PLAIN';
                }
                else if (smtp_properties.auth.indexOf('LOGIN') !== -1) {
                    mx.auth_type = 'LOGIN';
                }
            }

            if (!mx.auth_type || (mx.auth_type && smtp_properties.auth.indexOf(mx.auth_type.toUpperCase()) === -1)) {
                // No compatible authentication types offered by the server
                self.logwarn('AUTH configured for domain ' + self.todo.domain + ' but host ' +
                             host + 'did not offer any compatible types' +
                             ((mx.auth_type) ? ' (requested: ' + mx.auth_type + ')' : '') +
                             ' (offered: ' + smtp_properties.auth.join(',') + ')');
                // Proceed without authentication
                return send_command('MAIL', 'FROM:' + self.todo.mail_from);
            }

            switch (mx.auth_type.toUpperCase()) {
                case 'PLAIN':
                    return send_command('AUTH', 'PLAIN ' +
                        utils.base64(mx.auth_user + "\0" + mx.auth_user + "\0" + mx.auth_pass));
                case 'LOGIN':
                    authenticating = true;
                    return send_command('AUTH', 'LOGIN');
                case 'CRAM-MD5':
                    authenticating = true;
                    return send_command('AUTH', 'CRAM-MD5');
                default:
                    // Unsupported AUTH type
                    self.logwarn('Unsupported authentication type ' + mx.auth_type.toUpperCase() +
                                 ' requested for domain ' + self.todo.domain);
                    return send_command('MAIL', 'FROM:' + self.todo.mail_from);
            }
        }

        return send_command('MAIL', 'FROM:' + self.todo.mail_from);
    };

    var fp_called = false;
    var finish_processing_mail = function (success) {
        if (fp_called) {
            return self.logerror("finish_processing_mail called multiple times! Stack: " + (new Error()).stack);
        }
        fp_called = true;
        if (fail_recips.length) {
            self.refcount++;
            exports.split_to_new_recipients(self, fail_recips, "Some recipients temporarily failed", function (hmail) {
                self.discard();
                hmail.temp_fail("Some recipients temp failed: " + fail_recips.join(', '), { rcpt: fail_recips, mx: mx });
            });
        }
        if (bounce_recips.length) {
            self.refcount++;
            exports.split_to_new_recipients(self, bounce_recips, "Some recipients rejected", function (hmail) {
                self.discard();
                hmail.bounce("Some recipients failed: " + bounce_recips.join(', '), { rcpt: bounce_recips, mx: mx });
            });
        }
        processing_mail = false;
        if (success) {
            var reason = response.join(' ');
            self.delivered(host, port, (mx.using_lmtp ? 'LMTP' : 'SMTP'), mx.exchange,
                           reason, ok_recips, fail_recips, bounce_recips, secured, authenticated);
        }
        else {
            self.discard();
        }
        release_client(socket, port, host, mx.bind, fin_sent);
    };

    socket.on('line', function (line) {
        if (!processing_mail) {
            if (command !== 'quit') {
                self.logprotocol("Received data after stopping processing: " + line);
            }
            return;
        }
        self.logprotocol("S: " + line);
        var matches = smtp_regexp.exec(line);
        if (matches) {
            var reason;
            var code = matches[1];
            var cont = matches[2];
            var extc = matches[3];
            var rest = matches[4];
            response.push(rest);
            if (cont === ' ') {
                if (code.match(/^2/)) {
                    // Successful command, fall through
                }
                else if (code.match(/^3/) && command !== 'data') {
                    if (authenticating) {
                        var resp = response.join(' ');
                        switch (mx.auth_type.toUpperCase()) {
                            case 'LOGIN':
                                if (resp === 'VXNlcm5hbWU6') {
                                    // Username:
                                    return send_command(utils.base64(mx.auth_user));
                                }
                                else if (resp === 'UGFzc3dvcmQ6') {
                                    // Password:
                                    return send_command(utils.base64(mx.auth_pass));
                                }
                                break;
                            case 'CRAM-MD5':
                                // The response is our challenge
                                return send_command(cram_md5_response(mx.auth_user, mx.auth_pass, resp));
                            default:
                                // This shouldn't happen...
                        }
                    }
                    // Error
                    reason = response.join(' ');
                    recipients.forEach(function (rcpt) {
                        rcpt.dsn_action = 'delayed';
                        rcpt.dsn_smtp_code = code;
                        rcpt.dsn_smtp_extc = extc;
                        rcpt.dsn_status = extc;
                        rcpt.dsn_smtp_response = response.join(' ');
                        rcpt.dsn_remote_mta = mx.exchange;
                    });
                    send_command('RSET');
                    processing_mail = false;
                    release_client(socket, port, host, mx.bind);
                    return self.temp_fail("Upstream error: " + code + " " + ((extc) ? extc + ' ' : '') + reason);
                }
                else if (code.match(/^4/)) {
                    authenticating = false;
                    if (/^rcpt/.test(command) || command === 'dot_lmtp') {
                        if (command === 'dot_lmtp') last_recip = ok_recips.shift();
                        // this recipient was rejected
                        reason = code + ' ' + ((extc) ? extc + ' ' : '') + response.join(' ');
                        self.lognotice('recipient ' + last_recip + ' deferred: ' + reason);
                        last_recip.reason = reason;

                        last_recip.dsn_action = 'delayed';
                        last_recip.dsn_smtp_code = code;
                        last_recip.dsn_smtp_extc = extc;
                        last_recip.dsn_status = extc;
                        last_recip.dsn_smtp_response = response.join(' ');
                        last_recip.dsn_remote_mta = mx.exchange;

                        fail_recips.push(last_recip);
                        if (command === 'dot_lmtp') {
                            response = [];
                            if (ok_recips.length === 0) {
                                return finish_processing_mail(true);
                            }
                        }
                    }
                    else {
                        reason = response.join(' ');
                        recipients.forEach(function (rcpt) {
                            rcpt.dsn_action = 'delayed';
                            rcpt.dsn_smtp_code = code;
                            rcpt.dsn_smtp_extc = extc;
                            rcpt.dsn_status = extc;
                            rcpt.dsn_smtp_response = response.join(' ');
                            rcpt.dsn_remote_mta = mx.exchange;
                        });
                        send_command('RSET');
                        processing_mail = false;
                        release_client(socket, port, host, mx.bind);
                        return self.temp_fail("Upstream error: " + code + " " + ((extc) ? extc + ' ' : '') + reason);
                    }
                }
                else if (code.match(/^5/)) {
                    authenticating = false;
                    if (command === 'ehlo') {
                        // EHLO command was rejected; fall-back to HELO
                        return send_command('HELO', mx.bind_helo);
                    }
                    reason = code + ' ' + ((extc) ? extc + ' ' : '') + response.join(' ');
                    if (/^rcpt/.test(command) || command === 'dot_lmtp') {
                        if (command === 'dot_lmtp') last_recip = ok_recips.shift();
                        self.lognotice('recipient ' + last_recip + ' rejected: ' + reason);
                        last_recip.reason = reason;

                        last_recip.dsn_action = 'failed';
                        last_recip.dsn_smtp_code = code;
                        last_recip.dsn_smtp_extc = extc;
                        last_recip.dsn_status = extc;
                        last_recip.dsn_smtp_response = response.join(' ');
                        last_recip.dsn_remote_mta = mx.exchange;

                        bounce_recips.push(last_recip);
                        if (command === 'dot_lmtp') {
                            response = [];
                            if (ok_recips.length === 0) {
                                return finish_processing_mail(true);
                            }
                        }
                    }
                    else {
                        recipients.forEach(function (rcpt) {
                            rcpt.dsn_action = 'failed';
                            rcpt.dsn_smtp_code = code;
                            rcpt.dsn_smtp_extc = extc;
                            rcpt.dsn_status = extc;
                            rcpt.dsn_smtp_response = response.join(' ');
                            rcpt.dsn_remote_mta = mx.exchange;
                        });
                        send_command('RSET');
                        processing_mail = false;
                        release_client(socket, port, host, mx.bind);
                        return self.bounce(reason, { mx: mx });
                    }
                }
                switch (command) {
                    case 'connect':
                        send_command('EHLO', mx.bind_helo);
                        break;
                    case 'connect_lmtp':
                        send_command('LHLO', mx.bind_helo);
                        break;
                    case 'lhlo':
                    case 'ehlo':
                        process_ehlo_data();
                        break;
                    case 'starttls':
                        var tls_options = exports.get_tls_options(mx);

                        smtp_properties = {};
                        socket.upgrade(tls_options, function (authorized, verifyError, cert, cipher) {
                            self.loginfo('secured:' +
                                ((cipher) ? ' cipher=' + cipher.name + ' version=' + cipher.version : '') +
                                ' verified=' + authorized +
                              ((verifyError) ? ' error="' + verifyError + '"' : '' ) +
                              ((cert && cert.subject) ? ' cn="' + cert.subject.CN + '"' +
                              ' organization="' + cert.subject.O + '"' : '') +
                              ((cert && cert.issuer) ? ' issuer="' + cert.issuer.O + '"' : '') +
                              ((cert && cert.valid_to) ? ' expires="' + cert.valid_to + '"' : '') +
                              ((cert && cert.fingerprint) ? ' fingerprint=' + cert.fingerprint : ''));
                        });
                        break;
                    case 'auth':
                        authenticating = false;
                        authenticated = true;
                        send_command('MAIL', 'FROM:' + self.todo.mail_from);
                        break;
                    case 'helo':
                        send_command('MAIL', 'FROM:' + self.todo.mail_from);
                        break;
                    case 'mail':
                        last_recip = recipients[recip_index];
                        recip_index++;
                        send_command('RCPT', 'TO:' + last_recip.format());
                        break;
                    case 'rcpt':
                        if (last_recip && code.match(/^250/)) {
                            ok_recips.push(last_recip);
                        }
                        if (recip_index === recipients.length) { // End of RCPT TOs
                            if (ok_recips.length > 0) {
                                send_command('DATA');
                            }
                            else {
                                finish_processing_mail(false);
                                send_command('RSET');
                            }
                        }
                        else {
                            last_recip = recipients[recip_index];
                            recip_index++;
                            send_command('RCPT', 'TO:' + last_recip.format());
                        }
                        break;
                    case 'data':
                        var data_stream = self.data_stream();
                        data_stream.on('data', function (data) {
                            self.logdata("C: " + data);
                        });
                        data_stream.on('error', function (err) {
                            self.logerror("Reading from the data stream failed: " + err);
                        });
                        data_stream.on('end', function () {
                            send_command(mx.using_lmtp ? 'dot_lmtp' : 'dot');
                        });
                        data_stream.pipe(socket, {end: false});
                        break;
                    case 'dot':
                        finish_processing_mail(true);
                        send_command('RSET');
                        break;
                    case 'dot_lmtp':
                        if (code.match(/^2/)) lmtp_rcpt_idx++;
                        if (lmtp_rcpt_idx === ok_recips.length) {
                            finish_processing_mail(true);
                        }
                        break;
                    case 'quit':
                        self.logerror("We should NOT have sent QUIT from here...");
                        break;
                    case 'rset':
                        break;
                    default:
                        // should never get here - means we did something
                        // wrong.
                        throw new Error("Unknown command: " + command);
                }
            }
        }
        else {
            // Unrecognized response.
            self.logerror("Unrecognized response from upstream server: " + line);
            processing_mail = false;
            release_client(socket, port, host, mx.bind);
            self.todo.rcpt_to.forEach(function (rcpt) {
                self.extend_rcpt_with_dsn(rcpt, DSN.proto_invalid_command("Unrecognized response from upstream server: " + line));
            });
            return self.bounce("Unrecognized response from upstream server: " + line, {mx: mx});
        }
    });

    if (socket.__fromPool) {
        logger.logdebug('[outbound] got pooled socket, trying to deliver');
        send_command('MAIL', 'FROM:' + self.todo.mail_from);
    }
};

HMailItem.prototype.extend_rcpt_with_dsn = function (rcpt, dsn) {
    rcpt.dsn_code = dsn.code;
    rcpt.dsn_msg = dsn.msg;
    rcpt.dsn_status = "" + dsn.cls + "." + dsn.sub + "." + dsn.det;
    if (dsn.cls == 4) {
        rcpt.dsn_action = 'delayed';
    }
    else if (dsn.cls == 5) {
        rcpt.dsn_action = 'failed';
    }
};

HMailItem.prototype.populate_bounce_message = function (from, to, reason, cb) {
    var self = this;

    var buf = '';
    var original_header_lines = [];
    var headers_done = false;
    var header = new Header();

    try {
        var data_stream = this.data_stream();
        data_stream.on('data', function (data) {
            if (headers_done === false) {
                buf += data;
                var results;
                while ((results = utils.line_regexp.exec(buf))) {
                    var this_line = results[1];
                    if (this_line === '\n' || this_line == '\r\n') {
                        headers_done = true;
                        break;
                    }
                    buf = buf.slice(this_line.length);
                    original_header_lines.push(this_line);
                }
            }
        });
        data_stream.on('end', function () {
            if (original_header_lines.length > 0) {
                header.parse(original_header_lines);
            }
            self.populate_bounce_message_with_headers(from, to, reason, header, cb);
        });
        data_stream.on('error', function (err) {
            cb(err);
        });
    } catch (err) {
        self.populate_bounce_message_with_headers(from, to, reason, header, cb);
    }
}

/**
 * Generates a bounce message
 *
 * hmail.todo.rcpt_to objects should be extended as follows:
 * - dsn_action
 * - dsn_status
 * - dsn_code
 * - dsn_msg
 *
 * - dsn_remote_mta
 *
 * Upstream code/message goes here:
 * - dsn_smtp_code
 * - dsn_smtp_extc
 * - dsn_smtp_response
 *
 * @param from
 * @param to
 * @param reason
 * @param header
 * @param cb - a callback for fn(err, message_body_lines)
 */
HMailItem.prototype.populate_bounce_message_with_headers = function (from, to, reason, header, cb) {
    var self = this;
    var CRLF = '\r\n';

    var originalMessageId = header.get('Message-Id');

    var bounce_msg_ = config.get('outbound.bounce_message', 'data');
    var bounce_header_lines = [];
    var bounce_body_lines = [];
    var bounce_headers_done = false;
    bounce_msg_.forEach(function (line) {
        if (bounce_headers_done == false && line == '') {
            bounce_headers_done = true;
        }
        else if (bounce_headers_done == false) {
            bounce_header_lines.push(line);
        }
        else if (bounce_headers_done == true) {
            bounce_body_lines.push(line);
        }
    });


    var boundary = 'boundary_' + utils.uuid();
    var bounce_body = [];

    bounce_header_lines.forEach(function (line) {
        bounce_body.push(line + CRLF);
    });
    bounce_body.push('Content-Type: multipart/report; report-type=delivery-status;' + CRLF +
        '    boundary="' + boundary + '"' + CRLF);
    // Adding references to original msg id
    if (originalMessageId != '') {
        bounce_body.push('References: ' + originalMessageId.replace(/(\r?\n)*$/, '') + CRLF);
    }

    bounce_body.push(CRLF);
    bounce_body.push('This is a MIME-encapsulated message.' + CRLF);
    bounce_body.push(CRLF);

    bounce_body.push('--' + boundary + CRLF);
    bounce_body.push('Content-Type: text/plain; charset=us-ascii' + CRLF);
    bounce_body.push(CRLF);
    bounce_body_lines.forEach(function (line) {
        bounce_body.push(line + CRLF);
    });
    bounce_body.push(CRLF);

    bounce_body.push('--' + boundary + CRLF);
    bounce_body.push('Content-type: message/delivery-status' + CRLF);
    bounce_body.push(CRLF);
    if (originalMessageId != '') {
        bounce_body.push('Original-Envelope-Id: ' + originalMessageId.replace(/(\r?\n)*$/, '') + CRLF);
    }
    bounce_body.push('Reporting-MTA: dns;' + config.get('me') + CRLF);
    if (self.todo.queue_time) {
        bounce_body.push('Arrival-Date: ' + utils.date_to_str(new Date(self.todo.queue_time)) + CRLF);
    }
    self.todo.rcpt_to.forEach(function (rcpt_to) {
        bounce_body.push(CRLF);
        bounce_body.push('Final-Recipient: rfc822;' + rcpt_to.address() + CRLF);
        var dsn_action = null;
        if (rcpt_to.dsn_action) {
            dsn_action = rcpt_to.dsn_action;
        }
        else if (rcpt_to.dsn_code) {
            if (/^5/.exec(rcpt_to.dsn_code)) {
                dsn_action = 'failed';
            }
            else if (/^4/.exec(rcpt_to.dsn_code)) {
                dsn_action = 'delayed';
            }
            else if (/^2/.exec(rcpt_to.dsn_code)) {
                dsn_action = 'delivered';
            }
        }
        else if (rcpt_to.dsn_smtp_code) {
            if (/^5/.exec(rcpt_to.dsn_smtp_code)) {
                dsn_action = 'failed';
            }
            else if (/^4/.exec(rcpt_to.dsn_smtp_code)) {
                dsn_action = 'delayed';
            }
            else if (/^2/.exec(rcpt_to.dsn_smtp_code)) {
                dsn_action = 'delivered';
            }
        }
        if (dsn_action != null) {
            bounce_body.push('Action: ' + dsn_action + CRLF);
        }
        if (rcpt_to.dsn_status) {
            var dsn_status = rcpt_to.dsn_status;
            if (rcpt_to.dsn_code || rcpt_to.dsn_msg) {
                dsn_status += " (";
                if (rcpt_to.dsn_code) {
                    dsn_status += rcpt_to.dsn_code;
                }
                if (rcpt_to.dsn_code || rcpt_to.dsn_msg) {
                    dsn_status += " ";
                }
                if (rcpt_to.dsn_msg) {
                    dsn_status += rcpt_to.dsn_msg;
                }
                dsn_status += ")";
            }
            bounce_body.push('Status: ' + dsn_status + CRLF);
        }
        if (rcpt_to.dsn_remote_mta) {
            bounce_body.push('Remote-MTA: ' + rcpt_to.dsn_remote_mta + CRLF);
        }
        var diag_code = null;
        if (rcpt_to.dsn_smtp_code || rcpt_to.dsn_smtp_extc || rcpt_to.dsn_smtp_response) {
            diag_code = "smtp;";
            if (rcpt_to.dsn_smtp_code) {
                diag_code += rcpt_to.dsn_smtp_code + " ";
            }
            if (rcpt_to.dsn_smtp_extc) {
                diag_code += rcpt_to.dsn_smtp_extc + " ";
            }
            if (rcpt_to.dsn_smtp_response) {
                diag_code += rcpt_to.dsn_smtp_response + " ";
            }
        }
        if (diag_code != null) {
            bounce_body.push('Diagnostic-Code: ' + diag_code + CRLF);
        }
    });
    bounce_body.push(CRLF);

    bounce_body.push('--' + boundary + CRLF);
    bounce_body.push('Content-Description: Undelivered Message Headers' + CRLF);
    bounce_body.push('Content-Type: text/rfc822-headers' + CRLF);
    bounce_body.push(CRLF);
    header.header_list.forEach(function (line) {
        bounce_body.push(line);
    });
    bounce_body.push(CRLF);

    bounce_body.push('--' + boundary + '--' + CRLF);


    var values = {
        date: utils.date_to_str(new Date()),
        me:   config.get('me'),
        from: from,
        to:   to,
        subject: header.get_decoded('Subject').trim(),
        recipients: this.todo.rcpt_to.join(', '),
        reason: reason,
        extended_reason: this.todo.rcpt_to.map(function (recip) {
            if (recip.reason) {
                return recip.original + ': ' + recip.reason;
            }
        }).join('\n'),
        pid: process.pid,
        msgid: '<' + utils.uuid() + '@' + config.get('me') + '>',
    };

    cb(null, bounce_body.map(function (item) {
        return item.replace(/\{(\w+)\}/g, function (i, word) { return values[word] || '?'; });
    }));
}

HMailItem.prototype.bounce = function (err, opts) {
    this.loginfo("bouncing mail: " + err);
    if (!this.todo) {
        // haven't finished reading the todo, delay here...
        var self = this;
        self.once('ready', function () { self._bounce(err, opts); });
        return;
    }
    this._bounce(err, opts);
};

HMailItem.prototype._bounce = function (err, opts) {
    err = new Error(err);
    if (opts) {
        err.mx = opts.mx;
        err.deferred_rcpt = opts.fail_recips;
        err.bounced_rcpt = opts.bounce_recips;
    }
    this.bounce_error = err;
    plugins.run_hooks("bounce", this, err);
};

HMailItem.prototype.bounce_respond = function (retval, msg) {
    if (retval !== constants.cont) {
        this.loginfo("plugin responded with: " + retval + ". Not sending bounce.");
        return this.discard(); // calls next_cb
    }

    var self = this;
    var err  = this.bounce_error;

    if (!this.todo.mail_from.user) {
        // double bounce - mail was already a bounce
        return this.double_bounce("Mail was already a bounce");
    }

    var from = new Address ('<>');
    var recip = new Address (this.todo.mail_from.user, this.todo.mail_from.host);
    this.populate_bounce_message(from, recip, err, function (err2, data_lines) {
        if (err2) {
            return self.double_bounce("Error populating bounce message: " + err2);
        }

        exports.send_email(from, recip, data_lines.join(''), function (code, msg2) {
            if (code === constants.deny) {
                // failed to even queue the mail
                return self.double_bounce("Unable to queue the bounce message. Not sending bounce!");
            }
            self.discard();
        });
    });
};

HMailItem.prototype.double_bounce = function (err) {
    this.logerror("Double bounce: " + err);
    fs.unlink(this.path, function () {});
    this.next_cb();
    // TODO: fill this in... ?
    // One strategy is perhaps log to an mbox file. What do other servers do?
    // Another strategy might be delivery "plugins" to cope with this.
};

HMailItem.prototype.delivered = function (ip, port, mode, host, response, ok_recips, fail_recips, bounce_recips, secured, authenticated) {
    var delay = (Date.now() - this.todo.queue_time)/1000;
    this.lognotice("delivered file=" + this.filename +
                   ' domain="' + this.todo.domain + '"' +
                   ' host="' + host + '"' +
                   ' ip=' + ip +
                   ' port=' + port +
                   ' mode=' + mode +
                   ' tls=' + ((secured) ? 'Y' : 'N') +
                   ' auth=' + ((authenticated) ? 'Y' : 'N') +
                   ' response="' + response + '"' +
                   ' delay=' + delay +
                   ' fails=' + this.num_failures +
                   ' rcpts=' + ok_recips.length + '/' + fail_recips.length + '/' + bounce_recips.length);
    plugins.run_hooks("delivered", this, [host, ip, response, delay, port, mode, ok_recips, secured, authenticated]);
};

HMailItem.prototype.discard = function () {
    this.refcount--;
    if (this.refcount === 0) {
        // Remove the file.
        fs.unlink(this.path, function () {});
        this.next_cb();
    }
};

HMailItem.prototype.convert_temp_failed_to_bounce = function (err, extra) {
    this.todo.rcpt_to.forEach(function (rcpt_to) {
        rcpt_to.dsn_action = 'failed';
        if (rcpt_to.dsn_status) {
            rcpt_to.dsn_status = ("" + rcpt_to.dsn_status).replace(/^4/, '5');
        }
    });
    return this.bounce(err, extra);
}

HMailItem.prototype.temp_fail = function (err, extra) {
    logger.logdebug("Temp fail for: " + err);
    this.num_failures++;

    // Test for max failures which is configurable.
    if (this.num_failures >= (cfg.maxTempFailures)) {
        return this.convert_temp_failed_to_bounce("Too many failures (" + err + ")", extra);
    }

    // basic strategy is we exponentially grow the delay to the power
    // two each time, starting at 2 ** 6 seconds

    // Note: More advanced options should be explored in the future as the
    // last delay is 2**17 secs (1.5 days), which is a bit long... Exim has a max delay of
    // 6 hours (configurable) and the expire time is also configurable... But
    // this is good enough for now.

    var delay = Math.pow(2, (this.num_failures + 5));

    plugins.run_hooks('deferred', this, {delay: delay, err: err});
};

HMailItem.prototype.deferred_respond = function (retval, msg, params) {
    if (retval !== constants.cont && retval !== constants.denysoft) {
        this.loginfo("plugin responded with: " + retval + ". Not deferring. Deleting mail.");
        return this.discard(); // calls next_cb
    }

    var delay = params.delay * 1000;

    if (retval === constants.denysoft) {
        delay = parseInt(msg, 10) * 1000;
    }

    this.loginfo("Temp failing " + this.filename + " for " + (delay/1000) + " seconds: " + params.err);
    var parts = _qfile.parts(this.filename);
    parts.next_attempt = Date.now() + delay;
    parts.attempts = this.num_failures;
    var new_filename = _qfile.name(parts);
    // var new_filename = this`.filename.replace(/^(\d+)_(\d+)_/, until + '_' + this.num_failures + '_');

    var hmail = this;
    fs.rename(this.path, path.join(queue_dir, new_filename), function (err) {
        if (err) {
            return hmail.bounce("Error re-queueing email: " + err);
        }

        hmail.path = path.join(queue_dir, new_filename);
        hmail.filename = new_filename;

        hmail.next_cb();

        temp_fail_queue.add(delay, function () { delivery_queue.push(hmail); });
    });
};

// The following handler has an impact on outgoing mail. It does remove the queue file.
HMailItem.prototype.delivered_respond = function (retval, msg) {
    if (retval !== constants.cont && retval !== constants.ok) {
        this.logwarn("delivered plugin responded with: " + retval + " msg=" + msg + ".");
    }
    this.discard();
};
