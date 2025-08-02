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

export async function healthcheck1() {
  return {healthy: await checkHealth('http://host.docker.internal:8001/payments/service-health')};
}

export async function healthcheck2() {
  return {healthy: await checkHealth('http://host.docker.internal:8002/payments/service-health')};
}

// Checks both payments services health, returns boolean. 
export default async function (fastify: FastifyInstance) {
  fastify.get('/healthcheck1', async () => await healthcheck1());
  fastify.get('/healthcheck2', async () => await healthcheck2());
}

