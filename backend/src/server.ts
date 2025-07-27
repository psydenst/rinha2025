import Fastify from 'fastify';
import healthcheck from './healthcheck.js'; // Import the healthcheck plugin


const server = Fastify(); // Create a Fastify server instance
server.register(healthcheck); // Register healthcheck routes

const start = async () => {
	try {
		await server.listen({ port : 8080, host: '0.0.0.0'});
		console.log('Server listening at http://localhost:9999');
	} catch (err) {
		server.log.error(err);
		process.exit(1);
	}
}

start (); // Starts the server
