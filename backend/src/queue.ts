// queue.ts
import { fetch } from 'undici';

export interface PaymentBody {
  correlationId: string;
  amount: number;
}

export interface QueuedPayment extends PaymentBody {
  id: string;
  attempts: number;
  lastAttempt: number;
  maxRetries: number;
  delay: number;
  originalRequestTime: number;
  requestedAt: string; // para os processors
	registerSuccess?: boolean; // usado para registrar sucesso no summary
}

export interface QueueStats {
  queued: number;
  processed: number;
  failed: number;
  retries: number;
}


// Configurações da fila
const QUEUE_MAX_SIZE = 5000; // reduzido de 10k para 5k
const QUEUE_PROCESS_INTERVAL = 0; // --> 0ms instantaneo
const QUEUE_BATCH_SIZE = 1; // processar no máximo 1 pagamentos por vez --> instantaneo
const QUEUE_MAX_RETRIES = 3; // reduzido de 5 para 3
const QUEUE_INITIAL_DELAY = 0; // 10ms
const QUEUE_MAX_DELAY = 0; // 30ms
const QUEUE_BACKOFF_MULTIPLIER = 1.2;
const REQUEST_TIMEOUT = 1450; // 5s timeout
const QUEUE_IDLE_THRESHOLD = 30000; // 30s - parar processador se fila vazia por muito tempo

// Estado da fila
let paymentQueue: QueuedPayment[] = [];
let queueProcessorRunning = false;
let lastQueueActivity = Date.now(); // para idle detection
let queueStats: QueueStats = {
  queued: 0,
  processed: 0,
  failed: 0,
  retries: 0
};

// Função para fazer request
async function makeQueueRequest(
  url: string,
  payload: PaymentBody & { requestedAt: string },
  logger: any = console
): Promise<{ success: boolean; response?: any; status?: number }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

		const data = await resp.json() as { message: string };

    if (resp.status >= 200 && resp.status < 300) {
			// logger.info(`succes ${payload.correlationId} ${resp.status} data: ${data.message}`);
      return { success: true, response: data, status: resp.status };
    } else {
      // logger.warn(`Queue request returned ${resp.status} for ${payload.correlationId}`);
      return { success: false };
 			}
	} catch (error) {
   //  logger.error(`Queue request failed for ${payload.correlationId}:`, error);
    return { success: false };
  }
}

// Adicionar pagamento à fila
export function queuePayment(payment: PaymentBody): string {
  if (paymentQueue.length >= QUEUE_MAX_SIZE) {
    throw new Error('Payment queue is full');
  }

  const queuedPayment: QueuedPayment = {
    ...payment,
    requestedAt: new Date().toISOString(),
    id: `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    attempts: 0,
    lastAttempt: 0,
    maxRetries: QUEUE_MAX_RETRIES,
    delay: QUEUE_INITIAL_DELAY,
    originalRequestTime: Date.now(),
		registerSuccess: false
  };

  paymentQueue.push(queuedPayment);
  queueStats.queued++;
  lastQueueActivity = Date.now(); // atualizar activity
  
  // Iniciar processador da fila se não estiver rodando
  if (!queueProcessorRunning) {
    startQueueProcessor();
  }

  return queuedPayment.id;
}


async function processQueuedPayment(
  payment: QueuedPayment,
  healthCheck: () => Promise<{ p1: boolean; p2: boolean }>,
  logger: any = console
): Promise<boolean> {
  const now = Date.now();
  if (now - payment.lastAttempt < payment.delay) return false;

  payment.attempts++;
  payment.lastAttempt = now;
  // logger.info(`Processing queued payment ${payment.id}, attempt ${payment.attempts}/${payment.maxRetries}`);

  const { p1, p2 } = await healthCheck();
  const processorsToTry: Array<{ url: string; type: 'default' | 'fallback' }> = [];
  if (p1) processorsToTry.push({ url: 'http://host.docker.internal:8001/payments', type: 'default' });
  if (p2) processorsToTry.push({ url: 'http://host.docker.internal:8002/payments', type: 'fallback' });
  if (!processorsToTry.length) {
    processorsToTry.push(
      { url: 'http://host.docker.internal:8001/payments', type: 'default' },
      { url: 'http://host.docker.internal:8002/payments', type: 'fallback' }
    );
  }

  for (const processor of processorsToTry) {
    const result = await makeQueueRequest(processor.url, {
      correlationId: payment.correlationId,
      amount: payment.amount,
      requestedAt: payment.requestedAt
    }, logger);

		logger.info('result of makeQueueRequest', result);
    if (!result.success) {
      // logger.warn(`Payment ${payment.id} failed on ${processor.type}`);
      continue;
    }

    // logger.info(`Payment ${payment.id} succeeded on ${processor.type}`);
		// Condição para evitar duplo registro
    if (!payment.registerSuccess && result.success === true) {
      try {
        const summaryModule = await import('./summary.js');
        await summaryModule.registerPayment(processor.type, payment.amount, payment.correlationId);
        payment.registerSuccess = true;
        // logger.info(`Registered summary for payment ${payment.id}`);
      } catch (error) {
        // logger.error(`Summary registration error for payment ${payment.id}:`, error);
        // Não remove da fila; tentará novamente registrar na próxima iteração
        return false;
      }
    }

    // Só remove da fila após registro bem-sucedido ou já registrado
    queueStats.processed++;
    return true;
  }

  // Lógica de retry/backoff
  if (payment.attempts >= payment.maxRetries) {
    // logger.error(`Payment ${payment.id} permanently failed after ${payment.attempts} attempts`);
    queueStats.failed++;
    return true;
  }

  payment.delay = Math.min(payment.delay * QUEUE_BACKOFF_MULTIPLIER, QUEUE_MAX_DELAY);
  queueStats.retries++;
  // logger.warn(`Will retry payment ${payment.id} in ${payment.delay}ms`);
  return false;
}


// Iniciar processador da fila
function startQueueProcessor() {
  if (queueProcessorRunning) return;
  
  queueProcessorRunning = true;
  
  const processQueue = async () => {
    // Auto-shutdown se fila vazia por muito tempo (economizar recursos)
    if (paymentQueue.length === 0) {
      if (Date.now() - lastQueueActivity > QUEUE_IDLE_THRESHOLD) {
        // console.log('Queue processor stopping due to inactivity');
        queueProcessorRunning = false;
        return;
      }
      // Se não passou o threshold, reagendar check mais espaçado
      setTimeout(processQueue, QUEUE_PROCESS_INTERVAL * 2);
      return;
    }

    // Import dinâmico da função de health check (evita circular dependency)
    let healthCheck: () => Promise<{p1: boolean; p2: boolean}>;
    try {
      const healthModule = await import('./healthcheck.js');
      healthCheck = async () => {
        try {
          const [p1Result, p2Result] = await Promise.allSettled([
            Promise.race([
              healthModule.healthcheck1(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]),
            Promise.race([
              healthModule.healthcheck2(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ])
          ]);
          
          const p1 = p1Result.status === 'fulfilled' ? 
            Boolean((p1Result.value as any)?.healthy ?? p1Result.value) : false;
          const p2 = p2Result.status === 'fulfilled' ? 
            Boolean((p2Result.value as any)?.healthy ?? p2Result.value) : false;
            
          return { p1, p2 };
        } catch {
          return { p1: false, p2: false };
        }
      };
    } catch {
      // Fallback se não conseguir importar
      healthCheck = async () => ({ p1: true, p2: true });
    }

    // Processar apenas um BATCH por vez (evitar sobrecarga)
    const paymentsToProcess = paymentQueue.slice(0, QUEUE_BATCH_SIZE);
    const remainingPayments: QueuedPayment[] = paymentQueue.slice(QUEUE_BATCH_SIZE);
    
    let processedInBatch = 0;
    
    for (const payment of paymentsToProcess) {
      try {
        const shouldRemove = await processQueuedPayment(payment, healthCheck, console);
        if (shouldRemove) {
          processedInBatch++;
          lastQueueActivity = Date.now();
        } else {
          remainingPayments.unshift(payment); // recolocar no início
        }
      } catch (error) {
        // console.error(`Error processing queued payment ${payment.id}:`, error);
        remainingPayments.unshift(payment); // manter na fila em caso de erro
      }
    }
    
    paymentQueue = remainingPayments;
    /*
    if (processedInBatch > 0) {
      // console.log(`Queue batch processed: ${processedInBatch} payments, ${paymentQueue.length} remaining`);
    } */
    
    // Intervalo adaptativo: se processou algo, próximo batch mais rápido
    const nextInterval = processedInBatch > 0 ? 
      QUEUE_PROCESS_INTERVAL / 2 : // 1.5s se teve atividade
      QUEUE_PROCESS_INTERVAL;      // 3s se não teve atividade
    
    setTimeout(processQueue, nextInterval);
  };
  
  // Iniciar processamento
  setTimeout(processQueue, QUEUE_PROCESS_INTERVAL);
}

// Funções públicas para monitoramento
export function getQueueStatus() {
  return {
    size: paymentQueue.length,
    processing: queueProcessorRunning,
    stats: { ...queueStats },
    maxSize: QUEUE_MAX_SIZE
  };
}

export function getQueuedPayment(queueId: string): QueuedPayment | undefined {
  return paymentQueue.find(p => p.id === queueId);
}

// Função para forçar processamento (útil para testes)
export function forceProcessQueue() {
  if (!queueProcessorRunning) {
    startQueueProcessor();
  }
}
