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
  amount: number,
	correlationId: string
) {
	// Verifica se o pagamento já foi registrado
	const key = `payment:${correlationId}`;
	if (await redis.exists(key)) {
		console.info(`Summary: payment ${key} already registered, skipping.`);
		return;
	}
	// Registra o pagamento no Redis
  const timestamp = Date.now();
  await redis.hset(
	 `payment:${correlationId}`,
	 {// 1) chave do hash
		processor: processor,
		amount: amount,
		correlationId: correlationId,
		timestamp: timestamp.toString(),
		}
	);
}

export default async function summary(fastify: FastifyInstance) {
  fastify.addHook('onSend', async (_req, reply, _payload) => {
    reply.header('X-Service', 'rinha-payments-api');
  });

  fastify.get(
    '/payments-summary',
    async (
      req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>,
      reply: FastifyReply
    ) => {
      const { from, to } = req.query;
      const minTs = from ? new Date(from).getTime() : -Infinity;
      const maxTs = to ? new Date(to).getTime() : Infinity;

      // Inicializa agrupamentos
      const defaultGroup = {
        totalRequests: 0,
        totalAmount: 0,
        correlationIds: [] as string[],
      };
      const fallbackGroup = {
        totalRequests: 0,
        totalAmount: 0,
        correlationIds: [] as string[],
      };

      // Busca todas as chaves de pagamento
      const keys = await redis.keys('payment:*');
      for (const key of keys) { 
        const data = await redis.hgetall(key);
        const ts = parseInt(data.timestamp, 10);
        if (isNaN(ts) || ts < minTs || ts > maxTs) continue; // se não for número ou fora do intervalo, pula

        const amount = parseFloat(data.amount);
        const id = data.correlationId;
        const processor = data.processor as 'default' | 'fallback';

        if (processor === 'default') {
          defaultGroup.totalRequests += 1;
          defaultGroup.totalAmount += amount;
          defaultGroup.correlationIds.push(id);
        } else if (processor === 'fallback') {
          fallbackGroup.totalRequests += 1;
          fallbackGroup.totalAmount += amount;
          fallbackGroup.correlationIds.push(id);
        }
      }

      // Ajusta formatação dos valores, 2 casas decimais
      defaultGroup.totalAmount = Number(defaultGroup.totalAmount.toFixed(2));
      fallbackGroup.totalAmount = Number(fallbackGroup.totalAmount.toFixed(2));

      return reply.send({
        default: {
					totalRequests: defaultGroup.totalRequests,
					totalAmount: defaultGroup.totalAmount,
				},
        fallback: {
					totalRequests: fallbackGroup.totalRequests,
					totalAmount: fallbackGroup.totalAmount,
				},
      });
    }
  );
}
