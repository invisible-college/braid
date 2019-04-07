var fs = require('fs'),
    util = require('util')
var unique_sockjs_string = '_connect_to_statebus_'

function default_options (bus) { return {
    port: 'auto',
    backdoor: null,
    client: (c) => {c.shadows(bus)},
    file_store: {save_delay: 250, filename: 'db', backup_dir: 'backups', prefix: '*'},
    sync_files: [{state_path: 'files', fs_path: null}],
    serve: true,
    certs: {private_key: 'certs/private-key',
            certificate: 'certs/certificate',
            certificate_bundle: 'certs/certificate-bundle'},
    connections: {include_users: true, edit_others: true},
    __secure: false
}}

function set_options (bus, options) {
    var defaults = bus.clone(bus.options)
    options = options || {}
    for (var k in (options || {}))
        bus.options[k] = options[k]

    // Fill in defaults of nested options too
    for (var k in {file_store:1, certs:1})
        if (bus.options[k]) {
            if (typeof bus.options[k] !== 'object' || bus.options[k] === null)
                bus.options[k] = {}

            for (var k2 in defaults[k])
                if (!bus.options[k].hasOwnProperty(k2))
                    bus.options[k][k2] = defaults[k][k2]
        }
}

function import_server (bus, options)
{   var extra_methods = {

    serve: function serve (options) {
        var master = bus
        bus.honk = 'statelog'
        master.label = 'master'

        // Initialize Options
        set_options(bus, options)

        var use_ssl = bus.options.certs && (
               require('fs').existsSync(bus.options.certs.private_key)
            || require('fs').existsSync(bus.options.certs.certificate)
            || require('fs').existsSync(bus.options.certs.certificate_bundle))

        function c (client, conn) {
            client.honk = bus.honk
            client.serves_auth(conn, master)
            bus.options.client && bus.options.client(client, conn)
        }
        if (!bus.options.client) c = undefined // no client bus when programmer explicitly says so

        if (bus.options.file_store)
            bus.file_store()

        // ******************************************
        // ***** Create our own http server *********
        bus.make_http_server({port: bus.options.port, use_ssl})
        bus.sockjs_server(this.http_server, c) // Serve via sockjs on it
        var express = require('express')
        bus.express = express()
        bus.http = express.Router()
        bus.install_express(bus.express)

        // use gzip compression if available
        try { bus.http.use(require('compression')())
              console.log('Enabled http compression!') } catch (e) {}


        // Initialize new clients with an id.  We put the client id on
        // req.client, and also in a cookie for the browser to see.
        if (bus.options.client)
            bus.express.use(function (req, res, next) {
                req.client = require('cookie').parse(req.headers.cookie || '').client
                if (!req.client) {
                    req.client = (Math.random().toString(36).substring(2)
                                  + Math.random().toString(36).substring(2)
                                  + Math.random().toString(36).substring(2))
            
                    res.setHeader('Set-Cookie', 'client=' + req.client
                                  + '; Expires=21 Oct 2025 00:0:00 GMT;')
                }
                next()
            })

        // Initialize file sync
        ; (bus.options.sync_files || []).forEach( x => {
            if (require('fs').existsSync(x.fs_path || x.state_path))
                bus.sync_files(x.state_path, x.fs_path)
        })

        // User will put their routes in here
        bus.express.use('/', bus.http)

        // Add a fallback that goes to state
        bus.express.get('*', function (req, res) {
            // Make a temporary client bus
            var cbus = bus.bus_for_http_client(req, res)

            // Do the get
            cbus.honk = 'statelog'
            var singleton = req.path.match(/^\/code\//)
            cbus.get_once(req.path.substr(1), (o) => {
                var unwrap = (Object.keys(o).length === 2
                              && '_' in o
                              && typeof o._ === 'string')
                // To do: translate pointers as keys
                res.send(unwrap ? o._ : JSON.stringify(o))
                cbus.delete_bus()
            })
        })

        // Serve Client Coffee
        bus.serve_client_coffee()

        // Custom route
        var OG_route = bus.route
        bus.route = function(key, method, arg, opts) {
            var count = OG_route(key, method, arg, opts)

            // This whitelists anything we don't have a specific handler for,
            // reflecting it to all clients!
            if (count === 0 && method === 'to_set') {
                bus.set.fire(arg, opts)
                count++
            }

            return count
        }

        // Back door to the control room
        if (bus.options.backdoor) {
            bus.make_http_server({
                port: bus.options.backdoor,
                name: 'backdoor_http_server',
                use_ssl: use_ssl
            })
            bus.sockjs_server(this.backdoor_http_server)
        }
    },

    bus_for_http_client: function (req, res) {
        var bus = this
        if (!bus.bus_for_http_client.counter)
            bus.bus_for_http_client.counter = 0
        var cbus = require('./statebus')()
        cbus.label = 'client_http' + bus.bus_for_http_client.counter++
        cbus.master = bus

        // Log in as the client
        cbus.serves_auth({remoteAddress: req.connection.remoteAddress}, bus)
        bus.options.client(cbus)
        cbus.set({key: 'current_user', client: req.client})
        return cbus
    },

    make_http_server: function make_http_server (options) {
        options = options || {}
        var fs = require('fs')

        if (options.use_ssl) {
            // Load with TLS/SSL
            console.log('Encryption ON')

            // use http2 compatible library if available
            try {
                var http = require('spdy')
                console.log('Found spdy library. HTTP/2 enabled!')
            } catch (e) {
                var http = require('https')
            }

            var protocol = 'https'
            var ssl_options = {
                ca: (fs.existsSync(this.options.certs.certificate_bundle)
                     && require('split-ca')(this.options.certs.certificate_bundle)),
                key:  fs.readFileSync(this.options.certs.private_key),
                cert: fs.readFileSync(this.options.certs.certificate),
                ciphers: "ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384"
                    + ":ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256"
                    + ":ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256"
                    + ":HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA",
                honorCipherOrder: true}
        }
        else {
            // Load unencrypted server
            console.log('Encryption OFF')
            var http = require('http')
            var protocol = 'http'
            var ssl_options = undefined
        }

        if (options.port === 'auto') {
            var bind = require('./extras/tcp-bind')
            function find_a_port () {
                var next_port_attempt = 80
                while (true)
                    try {
                        var result = bind(next_port_attempt)
                        bus.port = next_port_attempt
                        return result
                    } catch (e) {
                        if (next_port_attempt < 3007) next_port_attempt = 3007
                        else next_port_attempt++
                    }
            }

            var fd
            if (options.use_ssl)
                try {
                    fd = bind(443)
                    bus.port = 443
                    bus.redirect_port_80()
                } catch (e) {fd = find_a_port()}
            else fd = find_a_port()
            var http_server = http.createServer(ssl_options)
            http_server.listen({fd: fd}, () => {
                console.log('Listening on '+protocol+'://<host>:'+bus.port)
            })
        }
        else {
            bus.port = bus.options.port
            var http_server = http.createServer(ssl_options)
            http_server.listen(bus.options.port, () => {
                console.log('Listening on '+protocol+'://<host>:'+bus.port)
            })
        }

        bus[options.name || 'http_server'] = http_server
    },

    redirect_port_80: function redirect_port_80 () {
        var redirector = require('http')
        redirector.createServer(function (req, res) {
            res.writeHead(301, {"Location": "https://"+req.headers['host']+req.url})
            res.end()
        }).listen(80)
    },

    install_express: function install_express (express_app) {
        this.http_server.on('request',  // Install express
                            function (request, response) {
                                // But express should ignore all sockjs requests
                                if (!request.url.startsWith('/'+unique_sockjs_string+'/'))
                                    express_app(request, response)
                            })

    },
    sockjs_server: function sockjs_server(httpserver, client_bus_func) {
        var master = this
        var client_num = 0
        // var client_busses = {}  // XXX work in progress
        var log = master.log
        if (client_bus_func) {
            master.set({key: 'connections'}) // Clean out old sessions
            var connections = master.get('connections')
        }
        var s = require('sockjs').createServer({
            sockjs_url: 'https://cdn.jsdelivr.net/sockjs/0.3.4/sockjs.min.js',
            disconnect_delay: 600 * 1000,
            heartbeat_delay: 6000 * 1000
        })
        s.on('connection', function(conn) {
            if (client_bus_func) {
                // To do for pooling client busses:
                //  - What do I do with connections?  Do they pool at all?
                //  - Before creating a new bus here, check to see if there's
                //    an existing one in the pool, and re-use it if so.
                //  - Count the number of connections using a client.
                //  - When disconnecting, decrement the number, and if it gets
                //    to zero, delete the client bus.

                connections[conn.id] = {client: conn.id, // client is deprecated
                                        id: conn.id}
                master.set(connections)

                var client = require('./statebus')()
                client.label = 'client' + client_num++
                master.label = master.label || 'master'
                client.master = master
                client_bus_func(client, conn)
            } else
                var client = master

            var subscriptions_to_us = {}  // Every key that this socket has gotton
            log('sockjs_s: New connection from', conn.remoteAddress)
            function sockjs_pubber (obj, t) {
                log('sockjs_pubber:', obj, t)
                var msg = {set: obj}
                if (t.version) msg.version = t.version
                if (t.parents) msg.parents = t.parents
                if (t.patch)   msg.patch =   t.patch
                if (t.patch)   msg.set    = msg.set.key
                msg = JSON.stringify(msg)

                if (global.network_delay) {
                    console.log('>>>> DELAYING!!!', global.network_delay)
                    obj = bus.clone(obj)
                    setTimeout(() => {conn.write(msg)}, global.network_delay)
                } else
                    conn.write(msg)

                log('sockjs_s: SENT a', msg, 'to client')
            }
            conn.on('data', function(message) {
                // log('sockjs_s:', message)
                try {
                    message = JSON.parse(message)
                    var method = bus.message_method(message)

                    // Validate the message
                    if (!((method === 'get'
                           && master.validate(message, {get: 'string',
                                                        '?parent': 'string', '?version': 'string'}))
                          ||
                          (method === 'set'
                           && master.validate(message, {set: '*',
                                                        '?parents': 'array', '?version': 'string', '?patch': 'array'})
                           && (typeof(message.set) === 'string'
                               || (typeof(message.set) === 'object'
                                   && typeof(message.set.key === 'string'))))
                          ||
                          (method === 'forget'
                           && master.validate(message, {forget: 'string'}))
                          ||
                          (method === 'delete'
                           && master.validate(message, {'delete': 'string'}))))
                        throw 'validation error'

                } catch (e) {
                    for (var i=0; i<4; i++) console.error('#######')
                    console.error('Received bad sockjs message from '
                                  + conn.remoteAddress +': ', message, e)
                    return
                }

                switch (method) {
                case 'get':
                    subscriptions_to_us[message.get] = true
                    client.get(message.get, sockjs_pubber)
                    break
                case 'forget':
                    delete subscriptions_to_us[message.forget]
                    client.forget(message.forget, sockjs_pubber)
                    break
                case 'delete':
                    client.delete(message['delete'])
                    break
                case 'set':
                    message.version = message.version || client.new_version()
                    if (message.patch) {
                        var o = bus.cache[message.set] || {key: message.set}
                        try {
                            message.set = bus.apply_patch(o, message.patch[0])
                        } catch (e) {
                            console.error('Received bad sockjs message from '
                                          + conn.remoteAddress +': ', message, e)
                            return
                        }
                    }
                    client.set(message.set,
                                {version: message.version,
                                 parents: message.parents,
                                 patch: message.patch})
                    if (subscriptions_to_us[message.set.key]) {  // Store what we've seen if we
                                                             // might have to publish it later
                        client.log('Adding', message.set.key+'#'+message.version,
                                   'to pubber!')
                        sockjs_pubber.has_seen(client, message.set.key, message.version)
                    }
                    break
                }

                // validate that our subscriptions_to_us are all in the bus
                for (var key in subscriptions_to_us)
                    if (!client.subscriptions_to_us.has(key, master.funk_key(sockjs_pubber)))
                        console.trace("***\n****\nFound errant key", key,
                                      'when receiving a sockjs', method, 'of', message)
                //log('sockjs_s: done with message')
            })
            conn.on('close', function() {
                log('sockjs_s: disconnected from', conn.remoteAddress, conn.id, client.id)
                for (var key in subscriptions_to_us)
                    client.forget(key, sockjs_pubber)
                if (client_bus_func) {
                    delete connections[conn.id]; master.set(connections)
                    client.delete_bus()
                }
            })

            // Define the /connection* state!
            if (client_bus_func && !master.options.__secure) {

                // A connection
                client('connection/*').to_get = function (key, star) {
                    var id = star
                    var conn = master.get('connections')[id]
                    if (!conn) return {error: 'connection ' + id + ' does not exist'}

                    var result = master.clone(conn)
                    result.key = key
                    result.id = id
                    result.client = id   // Deprecated

                    if (master.options.connections.include_users && result.user)
                        result.user = client.get(result.user.key)
                    return result
                }
                client('connection/*').to_set = function (o, star, t) {
                    // Check permissions before editing
                    if (star !== conn.id && !master.options.connections.edit_others) {
                        t.abort()
                        return
                    }
                    var connections = master.get('connections')
                    var result = client.clone(o)
                    var old = connections[star]
                    delete result.key
                    result.id = star
                    result.client = star   // Deprecated
                    result.user = old.user
                    connections[star] = result
                    master.set(connections)
                }

                // Your connection
                client('connection').to_get = function () {
                    // subscribe to changes in authentication
                    client.get('current_user')

                    var result = client.clone(client.get('connection/' + conn.id))
                    delete result.key
                    return result
                }
                client('connection').to_set = function (o) {
                    o = client.clone(o)
                    o.key = 'connection/' + conn.id
                    client.set(o)
                }

                // All connections
                client('connections').to_set = function noop (t) {t.abort()}
                client('connections').to_get = function () {
                    var result = []
                    var conns = master.get('connections')
                    for (var connid in conns)
                        if (connid !== 'key')
                            result.push(client.get('connection/' + connid))
                    
                    return {all: result}
                }
            }
        })

        s.installHandlers(httpserver, {prefix:'/' + unique_sockjs_string})
    },

    make_websocket: function make_websocket (url) {
        url = url.replace(/^state:\/\//, 'wss://')
        url = url.replace(/^istate:\/\//, 'ws://')
        url = url.replace(/^statei:\/\//, 'ws://')
        WebSocket = require('websocket').w3cwebsocket
        return new WebSocket(url+'/'+unique_sockjs_string+'/websocket')
    },
    client_creds: function client_creds (server_url) {
        // Right now the server just creates a different random id each time
        // it connects.
        return {clientid: (Math.random().toString(36).substring(2)
                           + Math.random().toString(36).substring(2)
                           + Math.random().toString(36).substring(2))}
    },

    // Deprecated
    ws_client: function (prefix, url, account) {
        console.error('ws_client() is deprecated; use net_mount() instead')
        bus.net_mount(prefix, url, account) },
    // Deprecated
    universal_ws_client: function () {
        console.error('calling universal_ws_client is deprecated and no longer necessary') },

    file_store: (function () {
        // Make a database
        var fs = require('fs')
        var db = {}
        var db_is_ok = false
        var pending_set = null
        var active
        function file_store (prefix, delay_activate) {
            prefix = prefix || bus.options.file_store.prefix
            var filename = bus.options.file_store.filename,
                backup_dir = bus.options.file_store.backup_dir

            // Loading db
            try {
                if (fs.existsSync && !fs.existsSync(filename))
                    (fs.writeFileSync(filename, '{}'), bus.log('Made a new db file'))
                db = JSON.parse(fs.readFileSync(filename))
                db_is_ok = true
                // If we set before anything else is connected, we'll get this
                // into the cache but not affect anything else
                bus.set.fire(global.pointerify ? inline_pointers(db) : db)
                bus.log('Read db')
            } catch (e) {
                console.error(e)
                console.error('bad db file')
            }

            // Saving db
            function set_db() {
                if (!db_is_ok) return

                console.time('setd db')

                fs.writeFile(filename+'.tmp', JSON.stringify(db, null, 1), function(err) {
                    if (err) {
                        console.error('Crap! DB IS DYING!!!!', err)
                        db_is_ok = false
                    } else
                        fs.rename(filename+'.tmp', filename, function (err) {
                            if (err) {
                                console.error('Crap !! DB IS DYING !!!!', err)
                                db_is_ok = false
                            } else {
                                console.timeEnd('setd db')
                                pending_set = null
                            }
                        })
                })
            }

            function save_later() {
                pending_set = pending_set || setTimeout(set_db, bus.options.file_store.save_delay)
            }
            active = !delay_activate

            // Replaces every nested keyed object with {_key: <key>}
            function abstract_pointers (o) {
                o = bus.clone(o)
                var result = {}
                for (var k in o)
                    result[k] = bus.deep_map(o[k], (o) => {
                        if (o && o.key) return {_key: o.key}
                        else return o
                    })
                return result
            }
            // ...and the inverse
            function inline_pointers (db) {
                return bus.deep_map(db, (o) => {
                    if (o && o._key)
                        return db[o._key]
                    else return o
                })
            }
            function on_set (obj) {
                db[obj.key] = global.pointerify ? abstract_pointers(obj) : obj
                if (active) save_later()
            }
            on_set.priority = true
            bus(prefix).on_set = on_set
            bus(prefix).to_delete = function (key) {
                delete db[key]
                if (active) save_later()
            }
            file_store.activate = function () {
                active = true
                save_later()
            }

            // Handling errors
            function recover (e) {
                if (e) {
                    process.stderr.write("Uncaught Exception:\n");
                    process.stderr.write(e.stack + "\n");
                }
                if (pending_set) {
                    console.log('Saving db after crash')
                    console.time()
                    fs.writeFileSync(filename, JSON.stringify(db, null, 1))
                    console.log('Setd db after crash')
                }
                process.exit(1)
            }
            process.on('SIGINT', recover)
            process.on('SIGTERM', recover)
            process.on('uncaughtException', recover)

            // Rotating backups
            setInterval(
                // This copies the current db over backups/db.<curr_date> every minute
                //
                // Note: in future we might want to use db.backup():
                // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise
                function backup_db() {
                    if (!db_is_ok || !backup_dir) return
                    if (fs.existsSync && !fs.existsSync(backup_dir))
                        fs.mkdirSync(backup_dir)

                    var d = new Date()
                    var y = d.getYear() + 1900
                    var m = d.getMonth() + 1
                    if (m < 10) m = '0' + m
                    var day = d.getDate()
                    if (day < 10) day = '0' + day
                    var date = y + '-' + m + '-' + day

                    //bus.log('Backing up db on', date)

                    require('child_process').execFile(
                        '/bin/cp', [filename, backup_dir+'/'+filename+'.'+date])
                },
                1000 * 60 // Every minute
            )
        }

        return file_store
    })(),

    firebase_store: function (prefix, firebase_ref) {
        prefix = prefix || '*'

        function encode_firebase_key(k) {
            return encodeURIComponent(k).replace(/\./g, '%2E')
        }

        function decode_firebase_key(k) {
            return decodeURIComponent(k.replace('%2E', '.'))
        }

        bus(prefix).to_get = function (key, t) {
            firebase_ref.child(encode_firebase_key(key)).on('value', function (x) {
                t.done(x.val() || {})
            }, function (err) { t.abort() })
        }

        bus(prefix).on_set = function (o) {
            firebase_ref.child(encode_firebase_key(o.key)).set(o)
        }

        // bus(prefix).to_set = function (o, t) {
        //     firebase_ref.child(encode_firebase_key(o.key)).set(o, (err) => {
        //         err ? t.abort() : t.done()
        //     })
        // }

        bus(prefix).to_delete = function (key, t) {
            firebase_ref.child(encode_firebase_key(key)).set(null, (err) => {
                err ? t.abort() : t.done()
            })
        }

        bus(prefix).to_forget = function (key, t) {
            firebase_ref.child(encode_firebase_key(key)).off()
        }
    },

    lazy_sqlite_store: function lazy_sqlite_store (opts) {
        if (!opts) opts = {}
        opts.lazy = true
        bus.sqlite_store(opts)
    },
    fast_load_sqlite_store: function sqlite_store (opts) {
        if (!opts) opts = {}
        opts.dont_fire = true
        bus.sqlite_store(opts)
    },
    sqlite_store: function sqlite_store (opts) {
        var prefix = '*'
        var open_transaction = null

        if (!opts) opts = {}
        if (!opts.filename) opts.filename = 'db.sqlite'

        // Load the db on startup
        try {
            var db = bus.sqlite_store_db || new (require('better-sqlite3'))(opts.filename)
            bus.sqlite_store_db = db
            bus.sqlite_store.load_all = load_all
            bus.sqlite_store.all_keys = all_keys

            db.pragma('journal_mode = WAL')
            db.prepare('create table if not exists cache (key text primary key, obj text)').run()

            function all_keys () {
                var result = []
                for (var row of db.prepare('select key from cache').iterate())
                    result.push(row.key)
                return result
            }
            function load_all (options) {
                var temp_db = {}

                for (var row of db.prepare('select * from cache').iterate()) {
                    var obj = JSON.parse(row.obj)
                    temp_db[obj.key] = obj
                }

                if (global.pointerify)
                    temp_db = inline_pointers(temp_db)

                for (var key in temp_db)
                    if (temp_db.hasOwnProperty(key)) {
                        if (opts.dont_fire)
                            bus.cache[key] = temp_db[key]
                        else
                            bus.set.fire(temp_db[key])
                        temp_db[key] = undefined
                    }
            }
            if (!opts.lazy) load_all(opts)

            bus.log('Read ' + opts.filename)
        } catch (e) {
            console.error(e)
            console.error('Bad sqlite db')
        }

        if (opts.lazy)
            // Add get handler
            bus(prefix).to_get = function (key, t) {
                var x = db.prepare('select * from cache where key = ?').get([key])
                t.done(x ? JSON.parse(x.obj) : {})
            }
            

        // Add set handlers
        function on_set (obj) {
            if (global.pointerify)
                obj = abstract_pointers(obj)

            if (opts.use_transactions && !open_transaction){
                console.time('save db')
                db.prepare('BEGIN TRANSACTION').run()
            }

            db.prepare('replace into cache (key, obj) values (?, ?)').run(
                [obj.key, JSON.stringify(obj)])

            if (opts.use_transactions && !open_transaction) {
                open_transaction = setTimeout(function(){
                    console.log('Committing transaction to database')
                    db.prepare('COMMIT').run()
                    open_transaction = false
                    console.timeEnd('save db')
                })
            }
        }
        if (opts.save_sync) {
            var old_route = bus.route
            bus.route = function (key, method, arg, t) {
                if (method === 'to_set') on_set(arg)
                return old_route(key, method, arg, t)
            }
        } else {
            on_set.priority = true
            bus(prefix).on_set = on_set
        }
        bus(prefix).to_delete = function (key) {
            if (opts.use_transactions && !open_transaction){
                console.time('save db')
                db.prepare('BEGIN TRANSACTION').run()
            }
            db.prepare('delete from cache where key = ?').run([key])
            if (opts.use_transactions && !open_transaction)
                open_transaction = setTimeout(function(){
                    console.log('committing')
                    db.prepare('COMMIT').run()
                    open_transaction = false
                    console.timeEnd('save db')
                })
        }

        // Replaces every nested keyed object with {_key: <key>}
        function abstract_pointers (o) {
            o = bus.clone(o)
            var result = {}
            for (var k in o)
                result[k] = bus.deep_map(o[k], (o) => {
                    if (o && o.key) return {_key: o.key}
                    else return o
                })
            return result
        }
        // ...and the inverse
        function inline_pointers (db) {
            return bus.deep_map(db, (o) => {
                if (o && o._key)
                    return db[o._key]
                else return o
            })
        }

        // Rotating backups
        setInterval(
            // Copy the current db over backups/db.<curr_date> every minute
            function backup_db() {
                if (opts.backups === false) return
                var backup_dir = opts.backup_dir || 'backups'
                if (fs.existsSync && !fs.existsSync(backup_dir))
                    fs.mkdirSync(backup_dir)

                var d = new Date()
                var y = d.getYear() + 1900
                var m = d.getMonth() + 1
                if (m < 10) m = '0' + m
                var day = d.getDate()
                if (day < 10) day = '0' + day
                var date = y + '-' + m + '-' + day

                require('child_process').execFile(
                    'sqlite3',
                    [opts.filename, '.backup '+"'"+backup_dir+'/'+opts.filename+'.'+date+"'"])
            },
            1000 * 60 // Every minute
        )
    },

    pg_store: function pg_store (opts) {
        opts = opts || {}
        opts.prefix = opts.prefix || '*'

        // Load the db on startup
        try {
            var db = new require('pg-native')()
            bus.pg_db = db
            bus.pg_set = pg_set
            db.connectSync(opts.url)
            db.querySync('create table if not exists store (key text primary key, value jsonb)')

            var rows = db.querySync('select * from store')
            rows.forEach(r => bus.set(inline_pointers(r.value, bus)))

            bus.log('Read ' + opts.url)
        } catch (e) {
            console.error(e)
            console.error('Bad pg db')
        }

        // Add set handlers
        function pg_set (obj) {
            obj = abstract_pointers(obj)

            db.querySync('insert into store (key, value) values ($1, $2) '
                         + 'on conflict (key) do update set value = $2',
                         [obj.key, JSON.stringify(obj)])
        }
        pg_set.priority = true
        bus(opts.prefix).on_set = pg_set
        bus(opts.prefix).to_delete = function (key) {
            db.query('delete from store where key = $1', [key])
        }

        // Replaces every nested keyed object with {_key: <key>}
        function abstract_pointers (o) {
            o = bus.clone(o)
            var result = {}
            for (var k in o)
                result[k] = bus.deep_map(o[k], (x) => {
                    if (x && x.key) return {_key: x.key}
                    else return x
                })
            return result
        }
        // ...and the inverse
        function inline_pointers (obj, bus) {
            return bus.deep_map(obj, (o) => {
                if (o && o._key) {
                    if (!bus.cache[o._key])
                        bus.cache[o._key] = {key: o._key}
                    return bus.cache[o._key]
                } else return o
            })
        }
    },

    setup_usage_log (opts) {
        bus.serve_time()
        opts = opts || {}
        opts.filename = opts.filename || 'db.sqlite'
        var db = new (require('better-sqlite3'))(opts.filename)
        bus.usage_log_db = db
        //db.pragma('journal_mode = WAL')
        db.prepare('create table if not exists usage (date integer, event text, details text)').run()
        db.prepare('create index if not exists date_index on usage (date)').run()
        var refresh_interval = 1000*60

        var nots = ['details not like "%facebookexternalhit%"',
                    'details not like "%/apple-touch-icon%"',
                    'details not like "%Googlebot%"',
                    'details not like "%AdsBot-Google%"',
                    'details not like "%Google-Adwords-Instant%"',
                    'details not like "%Apache-HttpClient%"',
                    'details not like "%SafeDNSBot%"',
                    'details not like "%RevueBot%"',
                    'details not like "%MetaURI API%"',
                    'details not like "%redback/v%"',
                    'details not like "%Slackbot%"',
                    'details not like "%HTTP_Request2/%"',
                    'details not like "%python-requests/%"',
                    'details not like "%LightspeedSystemsCrawler/%"',
                    'details not like "%CipaCrawler/%"',
                    'details not like "%Twitterbot/%"',
                    'details not like "%Go-http-client/%"',
                    'details not like "%/cheese_service%"'
                   ].join(' and ')
        bus.usage_log_nots = nots

        // Aggregate all accesses by day, to get daily active users
        bus('usage').to_get = () => {
            bus.get('time/' + refresh_interval)
            var days = []
            var last_day
            for (var row of db.prepare('select * from usage where '
                                       + nots + ' order by date').iterate()) {
                row.details = JSON.parse(row.details)
                if (row.details.agent && row.details.agent.match(/bot/)) continue

                var d = new Date(row.date * 1000)
                var day = d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate()
                if (last_day !== day)
                    days.push({day: day,    // Init
                               clients: new Set(),
                               ips: new Set(),
                               client_socket_opens: new Set(),
                               ip_socket_opens: new Set()
                              })
                last_day = day
                
                if (row.event === 'socket open') {
                    days[days.length-1].client_socket_opens.add(row.details.client)
                    days[days.length-1].ip_socket_opens.add(row.details.ip)
                }
                days[days.length-1].clients.add(row.details.client)
                days[days.length-1].ips.add(row.details.ip)
            }

            for (var i=0; i<days.length; i++)
                days[i] = {day: days[i].day,
                           ip_hits: days[i].ips.size,
                           client_hits: days[i].clients.size,
                           client_socket_opens: days[i].client_socket_opens.size,
                           ip_socket_opens: days[i].ip_socket_opens.size
                          }

            return {_: days}
        }

        bus('recent_hits/*').to_get = (rest) => {
            bus.get('time/' + refresh_interval)
            var result = []
            for (var row of db.prepare('select * from usage where '
                                       + nots + ' order by date desc limit ?').iterate(
                                           [parseInt(rest)])) {

                row.details = JSON.parse(row.details)
                if (row.details.agent && row.details.agent.match(/bot/)) continue

                result.push({url: row.details.url, ip: row.details.ip, date: row.date})
            }

            return {_: result}
        }

        bus('recent_referers/*').to_get = (rest) => {
            bus.get('time/' + refresh_interval)
            var result = []
            for (var row of db.prepare('select * from usage where '
                                       + nots + ' order by date desc limit ?').iterate(
                                           [parseInt(rest)])) {

                row.details = JSON.parse(row.details)
                if (row.details.agent && row.details.agent.match(/bot/)) continue

                if (row.details.referer && !row.details.referer.match(/^https:\/\/cheeseburgertherapy.com/))
                    result.push({url: row.details.url, referer: row.details.referer,
                                 date: row.date})
            }

            return {_: result}
        }


        function sock_open_time (sock_event) {
            var client = JSON.parse(sock_event.details).client
            if (!client) return null

            var http_req = db.prepare('select * from usage where event = "http request" and date < ? and '
                                      + ' details like ? and '
                                      + nots + ' order by date desc limit 1').get([sock_event.date,
                                                                                       '%'+client+'%'])
            if (!http_req) return null

            var delay = sock_event.date - http_req.date
            var res = !delay || delay > 300 ? 'fail' : delay
            if (delay && delay < 300
                && JSON.parse(sock_event.details).ip
                !== JSON.parse(http_req.details).ip)
                console.error('Yuck!', delay, sock_event, http_req)
            return [res, JSON.parse(http_req.details).url]
        }
        function sock_open_times () {
            var opens = db.prepare('select * from usage where event = "socket open" and '
                                   + nots + ' order by date desc limit ?').all(500)
            var times = []
            for (var i=0; i<opens.length; i++) {
                times.push(sock_open_time(opens[i]))
                // Get the most recent http hit before this open, from the same client id
                // subract the times
            }
            return times
        }

        bus('socket_load_times').to_get = () => {
            return {_: sock_open_times()}
        }
    },
    log_usage(event, details) {
        bus.usage_log_db.prepare('insert into usage (date, event, details) values (?, ?, ?)')
            .run([new Date().getTime()/1000,
                  event,
                  JSON.stringify(details)])
    },

    serve_time () {
        if (bus('time*').to_get.length > 0)
            // Then it's already installed
            return

        // Time ticker
        var timeouts = {}
        bus('time*').to_get =
            function (key, rest, t) {
                if (key === 'time') rest = '/1000'
                timeout = parseInt(rest.substr(1))
                function f () { bus.set.fire({key: key, time: Date.now()}) }
                timeouts[key] = setInterval(f, timeout)
                f()
            }
        bus('time*').to_forget =
            function (key, rest) {
                if (key === 'time') key = 'time/1000'
                clearTimeout(timeouts[key])
            }
    },

    smtp (opts) {
        var bus = this
        // Listen for SMTP messages on port 25
        if (opts.domain) {
            var mailin = require('mailin')
            mailin.start({
                port: opts.port || 25,
                disableWebhook: true,
                host: opts.domain,
                smtpOptions: { SMTPBanner: opts.domain }
            })
            // Event emitted after a message was received and parsed.
            mailin.on('message', (connection, msg, raw) => {
                if (!msg.messageId) {
                    console.log('Aborting message without id!', msg.subject, new Date().toLocaleString())
                    return
                }

                console.log(msg)
                console.log('Refs is', msg.references)
                console.log('Raw is', raw)
                var parent = msg.references
                if (parent) {
                    if (Array.isArray(parent))
                        parent = parent[0]
                    var m = parent.match(/\<(.*)\>/)
                    if (m && m[1])
                        parent = m[1]
                }
                var from = msg.from

                console.log('date is', msg.date, typeof(msg.date), msg.date.getTime())
                email = {
                    key: "email/" + msg.messageId,
                    _: {
                        title: msg.subject,
                        parent: parent && ("email/" + parent) || undefined,
                        from: msg.from.address,
                        to: msg.to.map(x=>x.address),
                        cc: msg.cc.map(x=>x.address),
                        date: msg.date.getTime() / 1000,
                        text: msg.text,
                        body: msg.text,
                        html: msg.html
                    }
                }

                bus.set(email)
            })
        }
    },

    serve_email (master, opts) {
        opts = opts || {}
        var client = this
        var email_regex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
        var peemail_regex = /^public$|^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
        // var local_addie_regex = new RegExp('state://' + opts.domain + '/user/([^\/]+)')
        // Todo on Server:
        //  - Connect with mailin, so we can receive SMTP shit
        //  
        //  - Is there security hole if users have a ? or a / in their name?
        //  - Make the master.posts/ state not require /
        //  - Make standard url tools for optional slashes, and ? query params
        //  - Should a e.g. client to_set abort if it calls set that aborts?
        //    - e.g. if master('posts*').to_set aborts

        // Helpers
        function get_posts (args) {
            console.log('getting posts with', args)
            var can_see = [{cc: ['public']}]
            if (args.for)
                can_see.push({to: [args.for]},
                             {cc: [args.for]},
                             {from: [args.for]})

            terms = '(' + can_see
                .map(x => "value @> '"+JSON.stringify({_:x})+"'")
                .join(' or ')
                + ')'

            if (args.about) {
                // console.log('getting one about', args.about)
                var interested_in = [{to: [args.about]},
                                     {cc: [args.about]},
                                     {from: [args.about]}]
                terms += ' and (' + interested_in
                    .map(x => "value @> '"+JSON.stringify({_:x})+"'")
                    .join(' or ')
                    + ')'
            }

            var q = "select value from store where key like 'post/%' and " + terms
            q += " order by value #>'{_,date}' desc"
            if (args.to) q += ' limit ' + to
            console.log('with query', q)
            return master.pg_db.querySync(q).map(x=>x.value)
        }
        function post_children (post) {
            return master.pg_db.querySync(
                "select value from store where value #>'{_,parent}' = '"
                    + JSON.stringify(post.key)
                    + "' order by value #>'{_,date}' asc").map(x=>x.value)
        }

        // function canonicalize_address (addie) {
        //     if (opts.domain) {
        //         // Try foo@gar.boo
        //         var m = addie.match(email_regex)
        //         if (m && m[5].toLowerCase() === opts.domain)
        //             return 'user/' + m[1]

        //         // Try state://gar.boo/user/foo
        //         m = addie.match(local_addie_regex)
        //         if (m) return 'user/' + m[1]
        //     }
        //     return addie
        // }

        // Define state on master
        if (master('posts_for/*').to_get.length === 0) {
            // Get posts for each user
            master('posts_for/*').to_get = (json) => {
                watch_for_dirt('posts-for/' + json.for)
                return {_: get_posts(json)}
            }
            // Saving any post will dirty the list for all users mentioned in
            // the post
            master('post/*').to_set = (old, New, t) => {
                // To do: diff the cc, to, and from lists, and only dirty
                // posts_for people who have been changed

                if (!old._) old = {_:{to: [], from: [], cc: []}}

                // old._.to = old._.to.map(a=>canonicalize_address(a))
                // old._.cc = old._.cc.map(a=>canonicalize_address(a))
                // old._.from = old._.from.map(a=>canonicalize_address(a))
                // New._.to = New._.to.map(a=>canonicalize_address(a))
                // New._.cc = New._.cc.map(a=>canonicalize_address(a))
                // New._.from = New._.from.map(a=>canonicalize_address(a))

                var dirtied = old._.to.concat(New._.to)
                    .concat(old._.cc).concat(New._.cc)
                    .concat(old._.from).concat(New._.from)
                dirtied.forEach(u=>dirty('posts-for/' + u))

                if (old._.parent) dirty(old._.parent)
                if (New._.parent) dirty(New._.parent)

                t.done(New)
            }
        }

        function user_addy (u) {
            return u.name + '@' + opts.domain
        }
        function current_addy () {
            var c = client.get('current_user')
            return c.logged_in ? user_addy(c.user) : 'public'
        }
        function is_author (post) {
            var from = post._.from
            var c = client.get('current_user')
            return from.includes(current_addy())
        }
        function can_see (post) {
            var c = client.get('current_user')
            var allowed = post._.to.concat(post._.cc).concat(post._.from)
            return allowed.includes(current_addy()) || allowed.includes('public')
        }
        var drtbus = master//require('./statebus')()
        function dirty (key) { drtbus.set({key: 'dirty-'+key, n: Math.random()}) }
        function watch_for_dirt (key) { drtbus.get('dirty-'+key) }

        client('current_email').to_get = () => {
            return {_: current_addy()}
        }

        // Define state on client
        client('posts*').to_get = (k, rest) => {
            var args = bus.parse(rest.substr(1))
            var c = client.get('current_user')
            args.for = current_addy()
            var e = master.get('posts_for/' + JSON.stringify(args))
            return {_: master.clone(e._).map(x=>client.get(x.key))}
        }

        client('post/*').to_get = (k) => {
            var e = master.clone(master.get(k))
            if (!e._) return {}
            if (!can_see(e))
                return {}
            
            e._.children = post_children(e).map(e=>e.key)
            watch_for_dirt(k)

            return e
        }

        client('post/*').to_set = (o, t) => {
            if (!(client.validate(o, {key: 'string',
                                     _: {to: 'array',
                                         cc: 'array',
                                         from: 'array',
                                         date: 'number',
                                         '?parent': 'string',
                                         body: 'string',
                                         '?title': 'string',
                                         '*': '*'}})
                  && o._.to.every(a=>a.match(peemail_regex))
                  && o._.cc.every(a=>a.match(peemail_regex))
                  && o._.from.every(a=>a.match(peemail_regex)))) {
                console.error('post no be valid', o)
                t.abort()
                return
            }

            var c = client.get('current_user')

            // Make sure this user is an author
            var from = o._.from
            if (!is_author(o)) {
                console.error('User', current_addy(),
			                  'is not author', o._.from)
                t.abort()
                return
            }
            o = client.clone(o)
            delete o.children

            master.set(o)
            t.done()
        }

        client('post/*').to_delete = (key, o, t) => {
            // Validate
            if (!is_author(o)) {
                console.error('User', current_addy(),
			                  'is not author', o._.from)
                t.abort()
                return
            }

            // master.delete(key)
            master.pg_db.query('delete from store where key = $1', [key])

            // Dirty everybody
            var dirtied = o._.to.concat(o._.cc).concat(o._.from)
            dirtied.forEach(u => dirty('posts-for/' + u))
            if (o._.parent) dirty(o._.parent)

            // To do: handle nested threads.  Either detach them, or insert a
            // 'deleted' stub, or splice together

            // Complete
            t.done()
        }

        client('friends').to_get = t => {
            return {_: (master.get('users').all||[])
                    .map(u=>client.get('email/' + user_addy(u)))
                    .concat([client.get('email/public')])
            }
        }

        client('email/*').to_get = (rest) => {
            var m = rest.match(email_regex)
            var result = {address: rest}
            if (rest === 'public') {
                result.name = 'public'
            }
            else if (m && m[5].toLowerCase() === opts.domain) {
                result.user = client.get('user/' + m[1])
                result.name = result.user.name
                result.pic = result.user.pic
                result.upgraded = true
            }
            else if (m) {
                result.name = m[1]
                result.upgraded = false
            }

            return result
        }
    },

    sqlite_query_server: function sqlite_query_server (db) {
        var get = bus.get
        bus('table_columns/*').to_get =
            function get_table_columns (key, rest) {
                if (typeof key !== 'string')
                    console.log(handlers.hash)
                var table_name = rest
                var columns = get('sql/PRAGMA table_info(' + table_name + ')').rows.slice()
                var foreign_keys = get('table_foreign_keys/' + table_name)
                var column_info = {}
                for (var i=0;i< columns .length;i++) {
                    var col = columns[i].name
                    column_info[col] = columns[i]
                    // if (col === 'customer' || col === 'customers')
                    //     console.log('FOR CUSTOMER, got', col, foreign_keys[col])
                    column_info[col].foreign_key = foreign_keys[col] && foreign_keys[col].table
                    columns[i] = col
                }
                columns.splice(columns[columns.indexOf('id')], 1)
                column_info['key'] = column_info['id']
                delete column_info['id']
                return {columns:columns, column_info:column_info}
            }


        bus('table_foreign_keys/*').to_get =
            function table_foreign_keys (key, rest) {
                var table_name = rest
                var foreign_keys = get('sql/PRAGMA foreign_key_list(' + table_name + ')').rows
                var result = {}
                for (var i=0;i< foreign_keys .length;i++)
                    result[foreign_keys[i].from] = foreign_keys[i]
                delete result.id
                result.key = key
                return result
            }

        bus('sql/*').to_get =
            function sql (key, rest) {
                get('timer/60000')
                var query = rest
                try { query = JSON.parse(query) }
                catch (e) { query = {stmt: query, args: []} }
                
                db.all(query.stmt, query.args,
                       function (err, rows) {
                           if (rows) bus.set.fire({key:key, rows: rows})
                           else console.error('Bad sqlite query', key, err)
                       }.bind(this))
            }
    },

    sqlite_table_server: function sqlite_table_server(db, table_name) {
        var set = bus.set, get = bus.get
        var table_columns = get('table_columns/'+table_name) // This will fail if used too soon
        var foreign_keys  = get('table_foreign_keys/'+table_name)
        var remapped_keys = get('remapped_keys')
        remapped_keys.keys = remapped_keys.keys || {}
        remapped_keys.revs = remapped_keys.revs || {}
        function row_json (row) {
            var result = {key: table_name + '/' + row.id}
            for (var k in row)
                if (row.hasOwnProperty(k))
                    result[k] = (foreign_keys[k] && row[k]
                                 ? foreign_keys[k].table + '/' + row[k]
                                 : result[k] = row[k])
            if (result.hasOwnProperty('other')) result.other = JSON.parse(result.other || '{}')
            delete result.id
            return result
        }
        function json_values (json) {
            var columns = table_columns.columns
            var result = []
            for (var i=0; i<columns.length; i++) {
                var col = columns[i]
                var val = json[col]

                // JSONify the `other' column
                if (col === 'other')
                    val = JSON.stringify(val || {})

                // Convert foreign keys from /customer/3 to 3
                else if (foreign_keys[col] && typeof val === 'string') {
                    val = remapped_keys.keys[val] || val
                    val = json[columns[i]].split('/')[1]
                }

                result.push(val)
            }
            return result
        }
        function render_table () {
            var result = []
            db.all('select * from ' + table_name, function (err, rows) {
                if (err) console.error('Problem with table!', table_name, err)
                for (var i=0; i<rows.length; i++)
                    result[i] = row_json(rows[i])
                bus.set.fire({key: table_name, rows: result})
            })
        }
        function render_row(obj) {
            bus.set.fire(row_json(obj))
            if (remapped_keys.revs[obj.key]) {
                var alias = bus.clone(obj)
                alias.key = remapped_keys.revs[obj.key]
                bus.set.fire(row_json(alias))
            }
        }

        // ************************
        // Handlers!
        // ************************

        // Getting the whole table, or a single row
        bus(table_name + '*').to_get = function (key, rest) {
            if (rest === '')
                // Return the whole table
                return render_table()

            if (rest[0] !== '/') return {error: 'bad key: ' + key}
            key = remapped_keys.keys[key] || key

            var id = key.split('/')[1]
            db.get('select * from '+table_name+' where rowid = ?',
                   [id],
                   function (err, row) {
                       if (!row)
                       { console.log('Row', id, "don't exist.", err); return }

                       render_row(row)
                   }.bind(this))
        }

        // Saving a row
        bus(table_name + '/*').to_set = function (obj, rest) {
            var columns = table_columns.columns
            var key = remapped_keys.keys[obj.key] || obj.key

            // Compose the query statement
            var stmt = 'update ' + table_name + ' set '
            var rowid = rest
            var vals = json_values(obj)
            for (var i=0; i<columns.length; i++) {
                stmt += columns[i] + ' = ?'
                //vals.push(obj[columns[i]])
                if (i < columns.length - 1)
                    stmt += ', '
            }
            stmt += ' where rowid = ?'
            vals.push(rowid)

            // Run the query
            db.run(stmt, vals,
                   function (e,r) {
                       console.log('updated',e,r,key)
                       bus.dirty(key)
                   })
        }

        // Inserting a new row
        bus('new/' + table_name + '/*').to_set = function (obj) {
            var columns = table_columns.columns
            var stmt = ('insert into ' + table_name + ' (' + columns.join(',')
                        + ') values (' + new Array(columns.length).join('?,') + '?)')
            var values = json_values(obj)

            console.log('Sqlite:' + stmt)

            db.run(stmt, values, function (error) {
                if (error) console.log('INSERT error!', error)
                console.log('insert complete, got id', this.lastID)
                remapped_keys.keys[obj.key] = table_name + '/' + this.lastID
                remapped_keys.revs[remapped_keys.keys[obj.key]] = obj.key
                set(remapped_keys)
                render_table()
            })
        }

        // Deleting a row
        bus(table_name + '/*').to_delete = function (key, rest) {
            if (remapped_keys.keys[key]) {
                var old_key = key
                var new_key = remapped_keys.keys[key]
                delete remapped_keys.keys[old_key]
                delete remapped_keys.revs[new_key]
                key = new_key
            }

            var stmt = 'delete from ' + table_name + ' where rowid = ?'
            var rowid = rest
            console.log('DELETE', stmt)
            db.run(stmt, [rowid],
                   function (err) {
                       if (err) console.log('DELETE error', err)
                       else     console.log('delete complete')
                       render_table() })
        }
    },

    serves_auth: function serves_auth (conn, master) {
        var client = this // to keep me straight while programming

        // Initialize master
        if (master('users/passwords').to_get.length === 0) {
            master('users/passwords').to_get = function (k) {
                var result = {key: 'users/passwords'}
                var users = master.get('users')
                users.all = users.all || []
                for (var i=0; i<users.all.length; i++) {
                    var u = master.get(users.all[i])
                    var login = (u.login || u.name).toLowerCase()
                    console.assert(login, 'Missing login for user', u)
                    if (result.hasOwnProperty(login)) {
                        console.error("upass: this user's name is bogus, dude.", u.key)
                        continue
                    }
                    result[login] = {user: u.key, pass: u.pass}
                }
                return result
            }

        }

        // Authentication functions
        function authenticate (login, pass) {
            var userpass = master.get('users/passwords')[login.toLowerCase()]
            master.log('authenticate: we see',
                master.get('users/passwords'),
                userpass && userpass.pass,
                pass)

            if (!(typeof login === 'string' && typeof pass === 'string')) return false
            if (login === 'key') return false
            if (!userpass || !userpass.pass) return null

            //console.log('comparing passwords', pass, userpass.pass)
            if (require('bcrypt-nodejs').compareSync(pass, userpass.pass))
                return master.get(userpass.user)
        }
        function create_account (params) {
            if (typeof (params.login || params.name) !== 'string')
                throw 'no login or name'
            var login = (params.login || params.name).toLowerCase()
            if (!login ||
                !master.validate(params, {'?name': 'string', '?login': 'string',
                                          pass: 'string', '?email': 'string',
                                          '?key': undefined, '*': '*'}))
                throw 'invalid name, login, pass, or email'

            var passes = master.get('users/passwords')
            if (passes.hasOwnProperty(login))
                throw 'there is already a user with that login or name'

            // Hash password
            params.pass = require('bcrypt-nodejs').hashSync(params.pass)

            // Choose account key
            var key = 'user/' + params.name
            if (!params.name)
                key = 'user/' + Math.random().toString(36).substring(7,13)
            while (master.cache.hasOwnProperty(key))
                key = 'user/' + Math.random().toString(36).substring(7,13)

            // Make account object
            var new_account = {key: key,
                               name: params.name,
                               login: params.login,
                               pass: params.pass,
                               email: params.email }
            for (var k in new_account) if (!new_account[k]) delete new_account[k]

            var users = master.get('users')
            users.all = users.all || []
            users.all.push(new_account)
            passes[login] = {user: new_account.key, pass: new_account.pass}
            master.set(new_account)
            master.set(users)
            master.set(passes)
        }

        // Current User
        client('current_user').to_get = function (k) {
            client.log('* getting: current_user')
            if (!conn.client) return
            var u = master.get('logged_in_clients')[conn.client]
            u = u && user_obj(u.key, true)
            return {user: u || null, logged_in: !!u}
        }

        client('current_user').to_set = function (o, t) {
            function error (msg) {
                client.set.abort(o)
                var c = client.get('current_user')
                c.error = msg
                client.set(c)
            }

            client.log('* saving: current_user!')
            if (o.client && !conn.client) {
                // Set the client
                conn.client = o.client
                client.client_id = o.client
                client.client_ip = conn.remoteAddress

                if (conn.id) {
                    var connections = master.get('connections')
                    connections[conn.id].user = master.get('logged_in_clients')[conn.client]
                    master.set(connections)
                }
            }
            else {
                if (o.create_account) {
                    client.log('current_user: creating account')
                    try {
                        create_account(o.create_account)
                        client.log('Success creating account!')
                        var cu = client.get('current_user')
                        cu.create_account = null
                        client.set.fire(cu)
                    } catch (e) {
                        error('Cannot create that account because ' + e)
                        return
                    }
                }

                if (o.login_as && conn.id) {
                    // Then client is trying to log in
                    client.log('current_user: trying to log in')
                    var creds = o.login_as
                    var login = creds.login || creds.name
                    if (login && creds.pass) {
                        // With a username and password
                        var u = authenticate(login, creds.pass)

                        client.log('auth said:', u)
                        if (u) {
                            // Success!
                            // Associate this user with this session
                            // user.log('Logging the user in!', u)

                            var clients     = master.get('logged_in_clients')
                            var connections = master.get('connections')

                            clients[conn.client]      = u
                            connections[conn.id].user = u

                            master.set(clients)
                            master.set(connections)

                            client.log('current_user: success logging in!')
                        }
                        else {
                            error('Cannot log in with that information')
                            return
                        }
                    }
                    else {
                        error('Cannot log in with that information')
                        return
                    }
                }

                else if (o.logout && conn.id) {
                    client.log('current_user: logging out')
                    var clients = master.get('logged_in_clients')
                    var connections = master.get('connections')

                    delete clients[conn.client]
                    connections[conn.id].user = null

                    master.set(clients)
                    master.set(connections)
                }
            }

            t.dirty()
        }
        client('current_user').to_delete = function () {}

        // Users have closet space at /user/<name>/*
        var closet_space_key = /^(user\/[^\/]+)\/.*/
        var private_closet_space_key = /^user\/[^\/]+\/private.*/

        // User
        client('user/*').to_set = function (o) {
            var c = client.get('current_user')
            var user_key = o.key.match(/^user\/([^\/]+)/)
            user_key = user_key && ('user/' + user_key[1])

            // Only the current user can touch themself.
            if (!c.logged_in || c.user.key !== user_key) {
                client.log('Only the current user can touch themself.',
                           {logged_in: c.logged_in, as: c.user && c.user.key,
                            touching: user_key})
                client.set.abort(o)
                return
            }

            // Users have closet space at /user/<name>/*
            if (o.key.match(closet_space_key)) {
                client.log('saving closet data')
                master.set(o)
                return
            }

            // Ok, then it must be a plain user
            console.assert(o.key.match(/^user\/[^\/]+$/))

            // Validate types
            if (!client.validate(o, {key: 'string', '?login': 'string', '?name': 'string',
                                     '?pass': 'string', '?email': 'string', /*'?pic': 'string',*/
                                     '*':'*'})) {
                client.log('This user change fails validation.')
                client.set.abort(o)
                return
            }

            // Rules for updating "login" and "name" attributes:
            //  • If "login" isn't specified, then we use "name" as login
            //  • That resulting login must be unique across all users

            // There must be at least a login or a name
            var login = o.login || o.name
            if (!login) {
                client.log('User must have a login or a name')
                client.set.abort(o)
                return
            }

            var u = master.get(o.key)
            var userpass = master.get('users/passwords')

            // Validate that the login/name is not changed to something clobberish
            var old_login = u.login || u.name
            if (old_login.toLowerCase() !== login.toLowerCase()
                && userpass.hasOwnProperty(login)) {
                client.log('The login', login, 'is already taken. Aborting.')
                client.set.abort(o)         // Abort

                o = client.get(o.key)      // Add error message
                o.error = 'The login "' + login + '" is already taken'
                client.set.fire(o)

                return                       // And exit
            }

            // Now we can update login and name
            u.login = o.login
            u.name = o.name

            // Hash password
            o.pass = o.pass && require('bcrypt-nodejs').hashSync(o.pass)
            u.pass = o.pass || u.pass

            // // Users can have pictures (remove this soon)
            // // Bug: if user changes name, this picture's url doesn't change.
            // if (o.pic && o.pic.indexOf('data:image') > -1) {
            //     var img_type = o.pic.match(/^data:image\/(\w+);base64,/)[1]
            //     var b64 = o.pic.replace(/^data:image\/\w+;base64,/, '')
            //     var upload_dir = global.upload_dir
            //     // ensure that the uploads directory exists
            //     if (!fs.existsSync(upload_dir))
            //         fs.mkdirSync(upload_dir)

            //     // bug: users with the same name can overwrite each other's files
            //     u.pic = u.name + '.' + img_type
            //     fs.writeFile(upload_dir + u.pic, b64, {encoding: 'base64'})
            // }

            // For anything else, go ahead and add it to the user object
            var protected = {key:1, name:1, /*pic:1,*/ pass:1}
            for (var k in o)
                if (!protected.hasOwnProperty(k))
                    u[k] = o[k]
            for (var k in u)
                if (!protected.hasOwnProperty(k) && !o.hasOwnProperty(k))
                    delete u[k]

            master.set(u)
        }
        client('user/*').to_get = function user_getter (k) {
            var c = client.get('current_user')
            client.log('* getting:', k, 'as', c.user)

            // Users have closet space at /user/<name>/*
            if (k.match(closet_space_key)) {
                var obj_user = k.match(closet_space_key)[1]
                if (k.match(private_closet_space_key)
                    && (!c.user || obj_user !== c.user.key)) {
                    client.log('hiding private closet data')
                    return {}
                }
                client.log('getting closet data')
                return client.clone(master.get(k))
            }

            // Otherwise return the actual user
            return user_obj(k, c.logged_in && c.user.key === k)
        }
        client('user/*').to_delete = function () {}
        function user_obj (k, logged_in) {
            var o = master.clone(master.get(k))
            if (k.match(/^user\/([^\/]+)\/private\/(.*)$/))
                return logged_in ? o : {key: k}
            
            delete o.pass
            if (!logged_in) {delete o.email; delete o.login}
            return o
        }

        // Blacklist sensitive stuff on master, in case we have a shadow set up
        var blacklist = 'users users/passwords logged_in_clients'.split(' ')
        for (var i=0; i<blacklist.length; i++) {
            client(blacklist[i]).to_get  = function () {}
            client(blacklist[i]).to_set   = function () {}
            client(blacklist[i]).to_delete = function () {}
            client(blacklist[i]).to_forget = function () {}
        }
    },

    persist: function (prefix_to_sync, validate) {
        var client = this
        var was_logged_in = false

        function client_prefix (current_user) {
            return 'client/' + (current_user.logged_in
                                 ? current_user.user.key.substr('user/'.length)
                                 : client.client_id)
        }

        function copy_client_to_user(client, user) {
            var old_prefix = 'client/' + client.client_id
            var new_prefix = 'client/' + user.key.substr('user/'.length)
            var cache = client.master.cache

            var keys = Object.keys(cache)         // Make a copy
            for (var i=0; i<keys.length; i++) {   // Because we'll mutate
                var old_key = keys[i]             // As we iterate

                if (old_key.startsWith(old_prefix)) {
                    var new_key = new_prefix + old_key.substr(old_prefix.length)
                    var o = client.clone(cache[old_key])
                    // Delete the old
                    client.master.del(old_key)

                    if (!(cache.hasOwnProperty(new_key))) {
                        // Set the new
                        o.key = new_key
                        client.master.set(o)
                    }
                }
            }
        }

        client(prefix_to_sync).to_get = function (key) {
            var c = client.get('current_user')
            if (client.loading()) return
            var prefix = client_prefix(c)

            if (!was_logged_in && c.logged_in)
                // User just logged in!  Let's copy his stuff over
                copy_client_to_user(client, c.user)
            was_logged_in = c.logged_in

            // Get the state from master
            var obj = client.clone(client.master.get(prefix + key))

            // Translate it back to client
            obj = client.deep_map(obj, function (o) {
                if (typeof o === 'object' && 'key' in o && typeof o.key === 'string')
                    o.key = o.key.substr(prefix.length)
                return o
            })
            return obj
        }

        client(prefix_to_sync).to_set = function (obj) {
            if (validate && !validate(obj)) {
                console.warn('Validation failed on', obj)
                client.set.abort(obj)
                return
            }

            var c = client.get('current_user')
            if (client.loading()) return
            var prefix = client_prefix(c)

            // Make it safe
            obj = client.clone(obj)
            obj = client.deep_map(obj, function (o) {
                if (typeof o === 'object' && 'key' in o && typeof o.key === 'string')
                    o.key = prefix + o.key
                return o
            })

            // Set to master
            client.master.set(obj)
        }

        client(prefix_to_sync).to_delete = function (k) {
            client.master.delete(client_prefix(client.get('current_user')) + k)
        }
    },

    shadows: function shadows (master_bus) {
        // Custom route
        var OG_route = bus.route
        bus.route = function(key, method, arg, t) {
            var count = OG_route(key, method, arg, t)
            // This forwards anything we don't have a specific handler for
            // to the global cache
            if (count === 0) {
                count++
                if (method === 'to_get')
                    bus.run_handler(function get_from_master (k) {
                        // console.log('DEFAULT GETting', k)
                        var r = master_bus.get(k)
                        // console.log('DEFAULT GETted', r)
                        bus.set.fire(r, {version: master_bus.versions[r.key]})
                        }, method, arg)
                else if (method === 'to_set')
                    bus.run_handler(function set_to_master (o, t) {
                        // console.log('DEFAULT ROUTE', t)
                        master_bus.set(o, t)
                    }, method, arg, {t: t})
                else if (method == 'to_delete')
                    bus.run_handler(function delete_from_master (k, t) {
                        master_bus.delete(k)
                        return 'done'
                    }, method, arg, {t: t})
            }
            return count
        }
    },

    read_file: function init () {
        // The first time this is run, we initialize it by loading some
        // libraries
        var chokidar = require('chokidar')
        var watchers = {}
        var fs = require('fs')

        // Now we redefine the function
        bus.read_file = bus.uncallback(
            function readFile (filename, encoding, cb) {
                fs.readFile(filename, (err, result) => {
                    if (err) console.error('Error from read_file:', err)
                    cb(null, ((result || '*error*').toString(encoding || undefined)))
                })
            },
            {
                callback_at: 2,
                start_watching: (args, dirty, del) => {
                    var filename = args[0]
                    console.log('## starting to watch', filename)
                    watchers[filename] = chokidar.watch(filename, {
                        atomic: true,
                        disableGlobbing: true
                    })
                    watchers[filename].on('change', () => { dirty() })
                    watchers[filename].on('add', () => { dirty() })
                    watchers[filename].on('unlink', () => { del() })
                },
                stop_watching: (json) => {
                    var filename = json[0]
                    console.log('## stopping to watch', filename)
                    // log('unwatching', filename)
                    // To do: this should probably use.unwatch() instead.
                    watchers[filename].close()
                    delete watchers[filename]
                }
            })
        return bus.read_file.apply(bus, [].slice.call(arguments))
    },

    // Synchronizes the recursive path starting with <state_path> to the
    // file or recursive directory structure at fs_path
    sync_files: function sync_files (state_path, file_path) {
        // To do:
        //  - Hook up a to_delete handler
        //    - recursively remove directories if all files gone

        console.assert(state_path.substr(-1) !== '*'
                       && (!file_path || file_path.substr(-1) !== '*'),
                       'The sync_files paths should not end with *')

        file_path = file_path || state_path
        var buffer = {}
        var full_file_path = require('path').join(__dirname, file_path)

        bus(state_path + '*').to_get = (rest) => {
            // We DO want to handle:
            //   - "foo"
            //   - "foo/*"
            // But not:
            //   - "foobar"
            if (rest.length>0 && rest[0] !== '/') return  // Bail on e.g. "foobar"

            var f = bus.read_file(file_path + rest, 'base64')

            // Clear buffer of items after 1 second. If fs results are delayed
            // longer, we'll just deal with those flashbacks.
            for (k in buffer)
                if (new Date().getTime() - buffer[k] > 1 * 1000)
                    delete buffer[k]

            // If we are expecting this, skip the read
            // console.log('read file', typeof f == 'string' ? f.substr(0,40) + '..': f)
            if (buffer[f]) {
                console.log('skipping cause its in buffer')
                return
            }

            return {_:f}
        }

        bus(state_path + '/*').to_set = (o, rest, t) => {
            if (rest.length>0 && rest[0] !== '/') return
            var f = Buffer.from(o._, 'base64')
            require('fs').writeFile(file_path + rest, f)
            buffer[f] = new Date().getTime()
            t.done()
        }

        bus.http.use('/'+state_path, require('express').static(full_file_path))
    },

    // Installs a GET handler at route that gets state from a getter function
    // Note: Makes too many textbusses.  Should re-use one.
    http_serve: function http_serve (route, getter) {
        var textbus = require('./statebus')()
        textbus.label = 'textbus'
        var watched = new Set()
        textbus('*').to_get = (filename, old) => {
            return {etag: Math.random() + '',
                    _: getter(filename)}
        }
        bus.http.get(route, (req, res) => {
            var path = req.path
            var etag = textbus.cache[path] && textbus.cache[path].etag
            if (etag && req.get('If-None-Match') === etag) {
                res.status(304).end()
                return
            }

            textbus.get(req.path) // So that textbus never clears the cache
            textbus.get(req.path, function cb (o) {
                res.setHeader('Cache-Control', 'public')
                // res.setHeader('Cache-Control', 'public, max-age='
                //               + (60 * 60 * 24 * 30))  // 1 month
                res.setHeader('ETag', o.etag)
                res.setHeader('content-type', 'application/javascript')
                res.send(o._)
                textbus.forget(o.key, cb)  // But we do want to forget the cb
            })
        })
    },

    serve_client_coffee: function serve_client_coffee () {
        bus.http_serve('/client/:filename', (filename) => {
            filename = /\/client\/(.*)/.exec(filename)[0]
            var source_filename = filename.substr(1)
            var source = bus.read_file(source_filename)
            if (filename.match(/\.coffee$/)) {

                try {
                    var compiled = require('coffeescript').compile(source, {filename,
                                                                            bare: true,
                                                                            sourceMap: true})
                } catch (e) {
                    if (!bus.loading())
                        console.error('Could not compile ' + e.toString())
                    return 'console.error(' + JSON.stringify(e.toString()) + ')'
                }

                var source_map = JSON.parse(compiled.v3SourceMap)
                source_map.sourcesContent = source
                compiled = 'window.dom = window.dom || {}\n' + compiled.js
                compiled = 'window.ui = window.ui || {}\n' + compiled

                function btoa(s) { return new Buffer(s.toString(),'binary').toString('base64') }

                // Base64 encode it
                compiled += '\n'
                compiled += '//# sourceMappingURL=data:application/json;base64,'
                compiled += btoa(JSON.stringify(source_map)) + '\n'
                compiled += '//# sourceURL=' + source_filename
                return compiled
            }
            else return source
        })
    },

    serve_clientjs: function serve_clientjs (path) {
        path = path || 'client.js'
        bus(path).to_get = () =>
            ({_:
              ['extras/coffee.js', 'extras/sockjs.js', 'extras/react.js',
               'statebus.js', 'client.js']
              .map((f) => bus.read_file('node_modules/statebus/' + f))
              .join(';\n')})
    },

    serve_wiki: () => {
        bus('edit/*').to_get = () => ({_: require('./extras/wiki.coffee').code})
    },

    unix_socket_repl: function (filename) {
        var repl = require('repl')
        var net = require('net')
        var fs = require('fs')
        if (fs.existsSync && fs.existsSync(filename))
            fs.unlinkSync(filename)
        net.createServer(function (socket) {
            var r = repl.start({
                //prompt: '> '
                input: socket
                , output: socket
                , terminal: true
                //, useGlobal: false
            })
            r.on('exit', function () {
                socket.end()
            })
            r.context.socket = socket
        }).listen(filename)
    },

    schema: function schema () {
        function url_tree (cache) {
            // The key tree looks like:
            //
            // {server: {thing: [obj1, obj2], shing: [obj1, obj2], ...}
            //  client: {dong: [obj1, ...]}}
            //
            // And objects without a number, like 'shong' will go on:
            //  key_tree.server.shong[null]
            var tree = {server: {}, client: {}}
            for (var key in cache) {
                var p = parse_key(key)
                if (!p) {
                    console.log('The state dash can\'t deal with key', key)
                    return null
                }
                tree[p.owner][p.name] || (tree[p.owner][p.name] = {})
                tree[p.owner][p.name][p.number || null] = cache[key]
            }
            return tree
        }

        function parse_key (key) {
            var word = "([^/]+)"
            // Matching things like: "/new/name/number"
            // or:                   "/name/number"
            // or:                   "/name"
            // or:                   "name/number"
            // or:                   "name"
            // ... and you can optionally include a final slash.
            var regexp = new RegExp("(/)?(new/)?" +word+ "(/" +word+ ")?(/)?")
            var m = key.match(regexp)
            if (!m) return null
            // indices = [0: has_match, 1: server_owned, 2: is_new, 3: name, 5: number]
            var owner = m[1] ? 'server' : 'client'
            return m[0] && {owner:owner, 'new': m[2], name: m[3], number: m[5]}
        }
        schema.parse_key = parse_key
        schema.url_tree = url_tree
        return url_tree(bus.cache)
    }
}
    // Add methods to bus object
    for (var m in extra_methods)
        bus[m] = extra_methods[m]

    bus.options = default_options(bus)
    set_options(bus, options)

    // Automatically make state:// get over a websocket
    bus.net_automount()
    return bus
}


// Handy functions for writing tests on nodejs
var tests = []
function test (f) {tests.push(f)}
function run_tests () {
    // Either run the test specified at command line
    if (process.argv[2])
        tests.find((f) => f.name == process.argv[2])(
            ()=>process.exit()
        )

    // Or run all tests
    else {
        function run_next () {
            if (tests.length > 0) {
                var f = tests.shift()
                delay_so_far = 0
                console.log('\nTesting:', f.name)
                f(function () {setTimeout(run_next)})
            } else
                (console.log('\nDone with all tests.'), process.exit())
        }
        run_next()
    }
}
function log () {
    var pre = '   '
    console.log(pre+util.format.apply(null,arguments).replace('\n','\n'+pre))
}
function assert () { console.assert.apply(console, arguments) }
function delay (time, f) {
    delay_so_far = delay_so_far + time
    return setTimeout(f, delay_so_far)
}
delay.init = _=> delay_so_far = 0
var delay_so_far = 0


// Now export everything
module.exports.import_server = import_server
module.exports.run_server = function (bus, options) { bus.serve(options) }
module.exports.import_module = function (statebus) {
    statebus.testing = {test, run_tests, log, assert, delay}

    statebus.serve = function serve (options) {
        var bus = statebus()
        require('./server').run_server(bus, options)
        return bus
    }

    // Handy repl. Invoke with node -e 'require("statebus").repl("/tmp/foo")'
    statebus.repl = function (filename) {
        var net = require('net')
        var sock = net.connect(filename)

        process.stdin.pipe(sock)
        sock.pipe(process.stdout)

        sock.on('connect', function () {
            process.stdin.resume();
            process.stdin.setRawMode(true)
        })

        sock.on('close', function done () {
            process.stdin.setRawMode(false)
            process.stdin.pause()
            sock.removeListener('close', done)
        })

        process.stdin.on('end', function () {
            sock.destroy()
            console.log()
        })

        process.stdin.on('data', function (b) {
            if (b.length === 1 && b[0] === 4) {
                process.stdin.emit('end')
            }
        })
    }
}
