// If you have no tests, uncomment this
// console.log("No test implemented.")
// process.exit(0)

// Import your code from dist directory, tests are not built on purpose
// import { randomFunction } from "../dist/index.js"
// import { subRandomFunction } from "../dist/submodule/index.js"
// // Import small testing lib from tsp
// import { describe, it, expect, startTest } from "@reflex-stack/tsp/tests"
//
// const endTest = startTest()
//
// describe("Main module", () => {
// 	it("Should call random", () => {
// 		const rootResult = randomFunction()
// 		expect(rootResult).toBe(5)
// 	})
// })
//
// describe("Sub module", () => {
// 	it("Should call sub random", () => {
// 		const subResult = subRandomFunction()
// 		expect(subResult).toBe(60)
// 	})
// 	// Test error example
// 	// it("Should fail", () => {
// 	// 	expect(5).toBe(12)
// 	// })
// })
//
// endTest()


import { createServerSocket } from "../dist/server/socket.server.js"
import { createClientSocket } from "../dist/client/socket.client.js"
import { SharedList } from "../dist/server/shared-entities.server.js";
import { createClientSharedEntities } from "../dist/client/shared-entities.client.js";
import { WebSocket } from "ws"
import fastify from "fastify";

let handleId = 0

const delay = (duration) => new Promise(resolve => setTimeout(resolve, duration * 1000))

// Create websocket server
const port = 3003
const server = fastify({})
server.listen({ host: '0.0.0.0', port })

const serverSocket = createServerSocket({
	server,
	pingInterval: 500,
	shouldHandleUpgrade (request) {
		return request.url.startsWith('/ws/')
	},
	async getLobbyFromRequest (request) {
		const { url } = request
		// Extract lobby id from url
		const key = url.split('/ws/', 2)[1] ?? ""
		// Return lobby for this key
		const lobby = serverSocket.getLobby(key)
		if ( !lobby )
			return
		return {
			...lobby,
			key,
			test: true, // fixme : test for generics
		}
	},
	async createHandleFromRequest (request) {
		await delay(1)
		// return "refused"
		return {
			// Create new id
			id: handleId++,
		}
	}
})

// Create some lobbies
const mainLobbyKey = "1234"
const mainLobby = serverSocket.openLobby(mainLobbyKey)


// Test server connexion refuse
// const clientSocket = createClientSocket({
// 	endpoint: `ws://localhost:${port}/ws/${mainLobbyKey}`,
// 	logLevel: 2,
// 	webSocketClass: WebSocket,
// });
//
// clientSocket.onConnectionUpdated.add((isConnected) => {
// 	console.log(`-> ${isConnected} ${clientSocket.lastConnexionError}`)
// })
//
// clientSocket.connect()
// 	.then(() => console.log("[client] connected"))
// 	.catch(() => console.error("[client] cannot connect"))
//


const allPlayers = new SharedList()
allPlayers.key = "players"
allPlayers.attach(serverSocket, mainLobby, 0)

serverSocket.onHandleConnected.add((lobby, handle) => {
	console.log("[server] handle connected", lobby.key, handle.id)
	allPlayers.add(handle.id)
})
serverSocket.onHandleDisconnected.add((lobby, handle) => {
	console.log("[server] handle remove", lobby.key, handle.id)
	allPlayers.remove(handle.id)
})
serverSocket.onPayload.add((payload, lobby, handle) => {
	console.log("[server] payload", payload, lobby.key, handle.id)
})

for ( let i = 0; i < 10; i++ ) {
	setTimeout( () => {
		const clientSocket = createClientSocket({
			endpoint: `ws://localhost:${port}/ws/${mainLobbyKey}`,
			logLevel: i === 0 ? 2 : 0,
			webSocketClass: WebSocket,
		});

		// console.log( clientSocket );
		clientSocket.connect()
			.then(() => console.log("[client] connected"))
			.catch(() => console.error("[client] cannot connect"))

		const sharedEntities = createClientSharedEntities(clientSocket)

		if ( i === 0 ) {
			clientSocket.onConnectionUpdated.once((isConnected) => {
				if (!isConnected)
					return
				console.log("[client] starting SE")
				sharedEntities.start()
					.then(() => console.log("[client] SE Started") )
					.catch(() => console.error("[client] SE Error"))
				sharedEntities.onUpdated.add((appId, key, action) => {
					console.log( "[client] shared entity updated", appId, key, action )
					if ( appId === 0 && key === "players" ) {
						const players = sharedEntities.getValue(appId, "players", true)
						console.log( players );
					}
				})
			})
		}

		setTimeout(() => {
			clientSocket.disconnect()
		}, 5000)

	}, (i + 1) * 100)
}

setTimeout(() => {
	server.close()
}, 10 * 1000)
