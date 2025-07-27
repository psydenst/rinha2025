// healthcheck.ts

import { FastifyInstance} from 'fastify'; // Fastify --> server object
import { request } from 'undici'; // undici --> HTTP client for making request
import { FastifyPluginAsync } from 'fastify'; // FastifyPluginAsync --> type for async plugins

// Helper to see payments health. Return boolean based on HTTP status code
async function checkHealth(url: string): Promise<boolean>
{
		const {statusCode} = await request(url); // GET payments/service-health
		if (statusCode >= 200 && statusCode < 300)
			return true; // If status code is 2xx, return true
		else
			return false; // Otherwise, return false
}

// Checks both payments services health, returns boolean. 
export default async function (fastify: FastifyInstance) {
// Checks payments services default health, returns boolean. 
	fastify.get('/healthcheck1', async () => {
		const healthy = await checkHealth('http://payment-processor-1:8080/payments/service-health');
		return { healthy };
	});
// Checks payments services fallback health, returns boolean. 
	fastify.get('/healthcheck2', async () => {
	const healthy = await checkHealth('http://payment-processor-2:8080/payments/service-health');
	return { healthy };
	});

}

