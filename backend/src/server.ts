import Fastify from 'fastify';
import healthcheck from './healthcheck.js'; // Import the healthcheck plugin
import payments from './payments.js'; // Import the payments plugin
import summary from './summary.js'; // Import the summary plugin

const server = Fastify({
	logger: true
}); // Create a Fastify server instance

server.register(healthcheck); // Register healthcheck routes
server.register(payments); // Register payments routes

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
