// payments.ts

import { FastifyInstance } from 'fastify'; // Fastify --> server object
import { request as undiciRequest} from 'undici'; // undici --> HTTP client for making request
import { FastifyPluginAsync } from 'fastify'; // FastifyPluginAsync --> type for async plugins
import { fetch } from 'undici';
import { healthcheck1, healthcheck2 } from './healthcheck.js'; // Import health check function
import { queuePayment, getQueueStatus, getQueuedPayment } from './queue.js';
import summary, { registerPayment} from './summary.js'; // Import queue functions

/* 
Pseudo Code:
	1. Criar globais para verificar saúde dos payment processor 1 e 2
  2. Função de api que receba correlationId e amount
	3. Verificar se o payment processor 1 está saudável
	4. Se saudável, chamar o endpoint de pagamento do payment processor 1
	5. Se não, verificar se o payment processor 2 está saudável
	  a. Se saudável, chamar o endpoint de pagamento do payment processor 2
		b. se não, criar um serviço de fila.

protótipo:

default:
await http://payment-processor-1:8080/payments \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{
  "correlationId": "",
  "amount": 1,
  "requestedAt": ""
}'

fallback:

await http://payment-processor-1:8080/payments \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{
  "correlationId": "",
  "amount": 1,
  "requestedAt": ""
}'

*/
export interface PaymentBody {
  correlationId: string
  amount: number
  // requestedAt: string
}

interface HealthResponse {
  healthy: boolean;
}

type HealthCache = {
	last: number;
	p1: boolean;
	p2: boolean;
}

type ProcessorStats = {
	failures: number;
	lastFailure: number;
	circuitOpen: boolean;
}

const HEALTH_TTL = 5_000; // 5 seconds
const CIRCUIT_BREAKER_THRESHOLD = 20; // number of failures before circuit opens
const CIRCUIT_BREAKER_TIMEOUT = 10_000; // 30 seconds before circuit resets
const REQUEST_TIMEOUT = 10_000; // 5 seconds timeout for requests
const MAX_RETRIES = 2; // maximum number of retries for requests

let healthCache: HealthCache = {last: 0, p1: false, p2: false};
let processor1Stats: ProcessorStats = {failures: 0, lastFailure: 0, circuitOpen: false};
let processor2Stats: ProcessorStats = {failures: 0, lastFailure: 0, circuitOpen: false};

function isCircuitOpen(stats: ProcessorStats): boolean {
	if (!stats.circuitOpen) {
		return false;
	}

	const now = Date.now();
	if (now - stats.lastFailure > CIRCUIT_BREAKER_TIMEOUT) {
		stats.circuitOpen = false; // reset circuit after timeout
		stats.failures = 0; // reset failure count
		return false;
	}
	return true;
}

function recordFailure(stats: ProcessorStats) {
	stats.failures++;
	stats.lastFailure = Date.now();

	if (stats.failures >= CIRCUIT_BREAKER_THRESHOLD) {
		stats.circuitOpen = true; // open circuit if threshold is reached
	}
}

function recordSucces(stats: ProcessorStats) {
	stats.failures = 0; // reset failure count on success
	stats.circuitOpen = false; // close circuit on success
}

async function getHealth(): Promise<{p1: boolean; p2: boolean}> {
	const now = Date.now();

  if (now - healthCache.last < HEALTH_TTL) {
    return { p1: healthCache.p1, p2: healthCache.p2 };
  }
	// launch health check in parallel, returns in 2s or error
	try {
		const healthPromises: [Promise<HealthResponse>, Promise<HealthResponse>]= [
			Promise.race(
				[healthcheck1(), 
					new Promise<HealthResponse>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
			]),
			Promise.race(
				[healthcheck2(), 
					new Promise<HealthResponse>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
			])
		];

		const [p1Result, p2Result]: [
			PromiseSettledResult<HealthResponse>,
			PromiseSettledResult<HealthResponse>
		] = await Promise.allSettled(healthPromises);
		// Check if the promises were fulfilled and extract the health status
		const p1Healthy = p1Result.status == 'fulfilled' ?
			Boolean((p1Result.value as any)?.healthy ?? p1Result.value) : false;
	
		const p2Healthy = p2Result.status == 'fulfilled' ?
			Boolean((p2Result.value as any)?.healthy ?? p2Result.value) : false;

    healthCache = { 
      last: now, 
      p1: p1Healthy && !isCircuitOpen(processor1Stats), 
      p2: p2Healthy && !isCircuitOpen(processor2Stats) 
    };

		return { p1: healthCache.p1, p2: healthCache.p2 };
	} catch (error) {
		if (now - healthCache.last < HEALTH_TTL) {
			return {p1: healthCache.p1, p2: healthCache.p2};
		}

		healthCache = { last: now, p1: false, p2: false };
		return { p1: false, p2: false};
		}
	}

	// Função para fazer request com retry e circuit breaker 
	async function makeRequest(
		url: string,
		payload: PaymentBody & { requestedAt: string},
		stats: ProcessorStats,
		processorName: string,
		logger: any
	): Promise<{success: boolean; response?: any; status?: number}>{
		
		if (isCircuitOpen(stats)) {
			logger.warn(`${processorName} circuit is open, skipping request`);
			return {success: false};
		}

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try{
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

				const resp = await (fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					signal: controller.signal
				}));

				clearTimeout(timeoutId);

				if (resp.ok) {
					recordSucces(stats);
					const data = await resp.json();
					return {success: true, response: data, status: resp.status};
				} else if (resp.status >= 500) {
					logger.warn(`${processorName} returned error ${resp.status} on attempt ${attempt}`);
					if (attempt === MAX_RETRIES) {
						recordFailure(stats);
					}
					continue;
				} else {
					recordSucces(stats);
					const data = await resp.json();
					return {success: true, response: data, status: resp.status};
				}
			} catch (error) {
				logger.error(error, `${processorName} attempt ${attempt} failed`);
				if (attempt === MAX_RETRIES) {
					recordFailure(stats);
				}

				if (attempt < MAX_RETRIES) {
					await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
				
				}
	     }		


		}
		
		return {success: false};
}



export default async function payments(fastify: FastifyInstance) {
	// register payments summary
	await summary(fastify);

	// Rota de status para monitoramento
  fastify.get('/payments/status', async (req, reply) => {
    const { p1, p2 } = await getHealth();
    const queueStatus = getQueueStatus();
    
    return reply.send({
      processors: {
        processor1: {
          healthy: p1,
          circuitOpen: processor1Stats.circuitOpen,
          failures: processor1Stats.failures
        },
        processor2: {
          healthy: p2,
          circuitOpen: processor2Stats.circuitOpen,
          failures: processor2Stats.failures
        }
      },
      queue: queueStatus
    });
  });

	  fastify.get<{ Params: { queueId: string } }>('/payments/queue/:queueId', async (req, reply) => {
    const { queueId } = req.params;
    
    const queuedPayment = getQueuedPayment(queueId);
    
    if (!queuedPayment) {
      return reply.code(404).send({ error: 'Queued payment not found' });
    }
    
    return reply.send({
      queueId: queuedPayment.id,
      correlationId: queuedPayment.correlationId,
      status: 'processing',
      attempts: queuedPayment.attempts,
      maxRetries: queuedPayment.maxRetries,
      nextAttempt: queuedPayment.lastAttempt + queuedPayment.delay,
      queuedAt: queuedPayment.originalRequestTime
    });
  });


  fastify.post<{ Body: PaymentBody }>('/payments', async (req, reply) => {
    const { correlationId, amount } = req.body;
		const requestedAt = new Date().toISOString();

    // on-demand health checks
    const { p1, p2 } = await getHealth();
		const queueStatus = getQueueStatus();

    // Verificar situação crítica ANTES de processar
    if (!p1 && !p2 && queueStatus.size >= queueStatus.maxSize) {
      req.log.error(`Critical situation: both processors down and queue full (${queueStatus.size}/${queueStatus.maxSize})`, {
        correlationId,
        p1Circuit: processor1Stats.circuitOpen,
        p2Circuit: processor2Stats.circuitOpen
      });
      
      return reply.code(500).send({
        error: 'System overloaded: payment processors unavailable and queue at capacity',
        correlationId,
        queueSize: queueStatus.size,
        maxQueueSize: queueStatus.maxSize
      });
    }


    if (p1) {
			const result = await makeRequest(
				'http://payment-processor-1:8080/payments',
				{ correlationId, amount, requestedAt },
				processor1Stats,
				'Payment Processor 1',
				req.log
			);

			if (result.success) {
				await registerPayment('default', amount);
				return reply.code(result.status || 200).send(result.response);
			}
    }

    if (p2) {
			const result = await makeRequest(
				'http://payment-processor-2:8080/payments',
				{ correlationId, amount, requestedAt },
				processor2Stats,
				'Payment Processor 2',
				req.log
			);

			if (result.success) {
				await registerPayment('fallback', amount);
				return reply.code(result.status || 200).send(result.response);
    	}
		}

		try {
			const queueId = queuePayment({correlationId, amount});

			req.log.info('Payment ${correlationId} queued for retry with ID ${queueId}');

			return reply.code(200).send({
			correlationId,
			queueId,
			status: 'queued'
			});
		} catch (error) {
			req.log.error(error, 'Failed to queue payment');

			return reply.code(500).send({
			error: 'Payment processors are unavailavle and queue is full',
			correlationId 
			});
		}
	});
}


