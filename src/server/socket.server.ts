import { WebSocketServer } from "ws";
import { FastifyInstance, FastifyRequest } from "fastify";
import * as stream from "node:stream";
import { Emitter, generateSimpleUID, ISocketPayload } from "../common/index.common.js";
import { TLogLevel } from "../client/socket.client.js";
import { AbstractSharedEntity } from "./shared-entities.server.js";

// Represents a socket
export interface IWSLike {
  on		: (type:string, handler:(...rest:any[]) => any) => void
  send	: (buffer:string) => void
  close	: () => void
}

export type TServerSocketHandle = {
	ws									:IWSLike
	hasSharedEntities		:boolean
}

export type TServerSocketLobby <GHandle extends TServerSocketHandle = TServerSocketHandle> = {
	opened					:boolean
	handles					:GHandle[]
	sharedEntities	:AbstractSharedEntity[]
}


type TOptions <
	GHandle extends TServerSocketHandle = TServerSocketHandle,
	GLobby extends TServerSocketLobby<GHandle> = TServerSocketLobby<GHandle>,
> = {
	server									: FastifyInstance
	logLevel          			?:TLogLevel
	pingInterval						?:number
	shouldHandleUpgrade		?:(request:FastifyRequest) => boolean | Promise<boolean>
	getLobbyFromRequest			: (request:FastifyRequest) => Promise<GLobby|null|string>
	createHandleFromRequest	?:(request:FastifyRequest, lobby:GLobby) => Promise<Omit<GHandle, "ws" | "hasSharedEntities">|null|string>
	webSocketServerOptions	?:typeof WebSocketServer.prototype.options
}

export type TServerSocket<
  GHandle extends TServerSocketHandle = TServerSocketHandle,
  GLobby extends TServerSocketLobby<GHandle> = TServerSocketLobby<GHandle>
> = ReturnType<typeof createServerSocket<GHandle, GLobby>>;

export function createServerSocket <
	GHandle extends TServerSocketHandle = TServerSocketHandle,
	GLobby extends TServerSocketLobby<GHandle> = TServerSocketLobby<GHandle>,
> ( options:TOptions ) {
	const serverStartTime = Date.now()
	// Extract options
	const { server, shouldHandleUpgrade, getLobbyFromRequest, createHandleFromRequest, webSocketServerOptions } = options
	// Default log level
	let { logLevel } = options
	logLevel ||= 0
	// Default ping interval
	let { pingInterval } = options
	pingInterval ??= 15 * 1000 // default to 15s
	// Initialize the WebSocket server instance
	const _socketServer = new WebSocketServer({
		noServer: true,
		...webSocketServerOptions
	})
	// List of lobbies
	const _lobbies = new Map<string, GLobby>()
	// Emitters
	const onPayload = Emitter<[ISocketPayload, GLobby, GHandle]>()
	const onHandleConnected = Emitter<[GLobby, GHandle]>()
	const onHandleDisconnected = Emitter<[GLobby, GHandle]>()

	// ----
	function newConnection ( ws:IWSLike, lobby:GLobby, handle:GHandle ) {
		// Inject socket into handle
		handle.ws = ws
		// Do not share entities with this handle until it has asked for it
		handle.hasSharedEntities = false

    // Send pings through websocket to prevent OS to cut the channel
    const pingTimer = setInterval(() => {
      ws.send(`@P-${generateSimpleUID(serverStartTime, 4, 4)}`)
    }, pingInterval)

		lobby.handles.push( handle )
		onHandleConnected.dispatch( lobby, handle )

    // Listen for handle messages
    ws.on('message', async (rawPayload:string) => {
      // Decode payload
      let payload:ISocketPayload
      try {
        payload = JSON.parse( rawPayload.toString() )
      }
      catch (e) {
				//todo : log
        // console.error(`Invalid payload from user ${user} - ${rawPayload}`)
        return
      }
			let answer:any = null
			if ( payload.t === '@SE' ) {
        lobby.sharedEntities.forEach( sharedEntity => sharedEntity.sendToHandle( handle ) )
				handle.hasSharedEntities = true
				// todo : we could theorically record the index of the shared entities sync object for every handle
				//        Store something like 100 sync objects max
				// 				if a handle disconnects, we send the diff, if it's more that 100 we send back all shared entities
				answer = '@OK'
      } else {
				// Notify payload
				// Keep only defined answer
				const answers = onPayload
					.dispatch(payload, lobby, handle)
					.filter( p => p !== undefined )
				// todo : error on answers length not correct
				if ( answers.length === 1 )
					answer = answers[0]
				else if ( answers.length > 1 && logLevel > 0 )
					console.log("Multiple payload answers", answers)
			}
			// Send answer back
			if ( typeof payload.u === "string" ) {
				if ( answer instanceof Promise )
					await answer
				const { a, t, u } = payload
				const buffer = JSON.stringify({ a, t, u, d: answer })
				handle.ws.send( buffer )
			}
    })
    // Socket close, delete from party
    // fixme : memory leak here ? does ws.close() remove all handlers ?
    ws.on('close', () => {
			// Remove handle from lobby
			lobby.handles = lobby.handles.filter( h => h !== handle )
			// Notify disconnection
			onHandleDisconnected.dispatch( lobby, handle )
			// Stop ping
			clearInterval( pingTimer )
    })
	}

	function refuseSocket (socket:stream.Duplex, reason:string = "refused") {
		// this prevent error in http syntax in node internals ( delay + send bad request )
		setTimeout(() => {
			socket.write(
				`HTTP/1.1 400 Bad Request\r\n` +
				`X-Rejection-Reason: ${reason}\r\n` +
				`\r\n`
			);
			socket.destroy();
		}, 200)
	}

	function closeWithReason (ws:IWSLike, reason:string) {
		ws.send(`@CE ${reason}`)
		setTimeout(() => { ws.close() }, 200)
	}

	function refuseWithMessage ( request:FastifyRequest, socket:stream.Duplex, head:Buffer, reason:string ) {
		_socketServer.handleUpgrade(request as any, socket, head, (ws:IWSLike) => {
			// Notify server socket and register all data
			closeWithReason(ws, reason)
		})
	}

	// We received a WebSocket connection request
	async function serverUpgradeHandler ( request:FastifyRequest, socket:stream.Duplex, head:Buffer ) {
		//
		try {
			if ( shouldHandleUpgrade && !await shouldHandleUpgrade( request ) )
				return
			// Create lobby from request
			let lobby = await getLobbyFromRequest( request )
			// Invalid lobby
			const lobbyIsString = typeof lobby === "string"
			if ( !lobby || lobbyIsString )
				return refuseWithMessage( request, socket, head, lobbyIsString ? lobby : "unknown" )
			// Create handle from request
			const handle = createHandleFromRequest ? await createHandleFromRequest( request, lobby ) : {}
			// Invalid handle
			const handleIsString = typeof handle === "string"
			if ( !handle || handleIsString )
				return refuseWithMessage( request, socket, head, handleIsString ? handle : "unknown" )
			// Allow proto upgrade
			_socketServer.handleUpgrade(request as any, socket, head, (ws:IWSLike) => {
				// Notify server socket and register all data
				_socketServer.emit('connection', ws, lobby, handle)
			})
		}
		catch ( error ) {
			if ( options.logLevel > 0 ) {
				console.log("Error while upgrading socket")
				console.error( error )
			}
			return refuseSocket( socket, "error" )
		}
	}

	// Listen for new connections
	_socketServer.on('connection', newConnection)
	server.server.on('upgrade', serverUpgradeHandler)

	//
	const api = {
		// List all lobbies
		getLobbies ():GLobby[] { return [..._lobbies.values()] },
		getLobby ( key:string ):GLobby|null {
			return _lobbies.get( key )
		},
		openLobby ( key:string, lobbyObject?:Omit<GLobby, "handles"|"sharedEntities"|"opened"> ):GLobby|null {
			let lobby = _lobbies.get( key )
			if ( lobby )
				return null
			lobby = {
				opened: true,
				handles: [],
				sharedEntities: [],
				...lobbyObject,
			} as GLobby
			_lobbies.set( key, lobby )
			return lobby
		},
		closeLobby ( key:string, reason:string = null ):boolean {
			const lobby = _lobbies.get( key )
			if ( !lobby )
				return false
			if ( !lobby.opened )
				return false
			// Disconnect all handles on this lobby
			lobby.handles.forEach( handle => api.disconnectHandle( handle, reason ) )
			// Remove all shared entities from memory and from database
			// Do it after apps so we dispose only the remaining entities that were not
			// dispose in apps
			lobby.sharedEntities.forEach( entity => {
				if (entity.parentKey)
					return
				entity.dispose()
			})
			_lobbies.delete( key )
			lobby.opened = false
			return true
		},
		//
		onHandleConnected,
		onHandleDisconnected,
		disconnectHandle ( handle:GHandle, reason:string = null ) {
			// fixme does it remove it from handles list in lobby ?
			if ( reason )
				closeWithReason(handle.ws, reason)
			else
				handle.ws.close()
		},
		//
		onPayload,
		sendPayload (handles:GHandle[], a:number /* app id */, t:string /* type */ , d:any /* data */ = null ) {
			const buffer = JSON.stringify({ a, t, d })
      handles.map( h => h.ws.send( buffer ) )
		},
		//
		dispose () {
			// todo : remove everything else
			server.server.off('upgrade', serverUpgradeHandler)
			_socketServer.removeAllListeners()
			_socketServer.close()
		},
	}
	return Object.freeze(api)
}
