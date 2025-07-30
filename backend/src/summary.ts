// summary.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
});


// captura e loga o erro ao invés de deixar não tratado
redis.on('error', (err) => {
  console.error('❌ Redis connection error:', err);
});

/**
 * Register a payment by adding an entry to a Redis sorted set
 * with the timestamp as score and amount as value.
 */
export async function registerPayment(
  processor: 'default' | 'fallback',
  amount: number
) {
  const timestamp = Date.now();
  await redis.zadd(`payments:${processor}`, timestamp, amount.toString());
}

/**
 * Summary endpoint: returns counts and sums between optional 'from' and 'to' ISO timestamps.
 */
export default async function summary(fastify: FastifyInstance) {

	fastify.addHook('onSend', async (req, reply, payload) => {
	reply.header('X-Service', 'rinha-payments-api');
	});

	fastify.get('/payments-summary', async (
    req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>,
    reply: FastifyReply
  ) => {
    const { from, to } = req.query;
    const minScore = from ? new Date(from).getTime() : '-inf';
    const maxScore = to ? new Date(to).getTime() : '+inf';

    // Default processor stats
    const defaultCount = await redis.zcount('payments:default', minScore, maxScore);
    const defaultAmounts = await redis.zrangebyscore('payments:default', minScore, maxScore);
    const defaultTotal = defaultAmounts.reduce((sum, value) => sum + parseFloat(value), 0);

    // Fallback processor stats
    const fallbackCount = await redis.zcount('payments:fallback', minScore, maxScore);
    const fallbackAmounts = await redis.zrangebyscore('payments:fallback', minScore, maxScore);
    const fallbackTotal = fallbackAmounts.reduce((sum, value) => sum + parseFloat(value), 0);

    return reply.send({
      default: {
        totalRequests: defaultCount,
        totalAmount: Number(defaultTotal.toFixed(2)),
      },
      fallback: {
        totalRequests: fallbackCount,
        totalAmount: Number(fallbackTotal.toFixed(2)),
      }
    });
  });
}
