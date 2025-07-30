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
}

export interface QueueStats {
  queued: number;
  processed: number;
  failed: number;
  retries: number;
}

// Configurações da fila
const QUEUE_MAX_SIZE = 5000; // reduzido de 10k para 5k
const QUEUE_PROCESS_INTERVAL = 3000; // 3 segundos - muito mais econômico
const QUEUE_BATCH_SIZE = 10; // processar no máximo 10 pagamentos por vez
const QUEUE_MAX_RETRIES = 3; // reduzido de 5 para 3
const QUEUE_INITIAL_DELAY = 2000; // 2s
const QUEUE_MAX_DELAY = 60000; // 60s (aumen
const QUEUE_BACKOFF_MULTIPLIER = 2;
const REQUEST_TIMEOUT = 5000; // 5s timeout
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

// Função para fazer request (simplificada para a fila)
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

    if (resp.ok) {
      const data = await resp.json();
      return { success: true, response: data, status: resp.status };
    } else if (resp.status >= 500) {
      logger.warn(`Queue request returned ${resp.status} for ${payload.correlationId}`);
      return { success: false };
    } else {
      // Client error (4xx) - não tentar novamente
      const data = await resp.json();
      return { success: true, response: data, status: resp.status };
    }
  } catch (error) {
    logger.error(`Queue request failed for ${payload.correlationId}:`, error);
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
    originalRequestTime: Date.now()
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

// Processar um pagamento da fila
async function processQueuedPayment(
  payment: QueuedPayment,
  healthCheck: () => Promise<{p1: boolean; p2: boolean}>,
  logger: any = console
): Promise<boolean> {
  const now = Date.now();
  
  // Verificar se já passou o delay necessário
  if (now - payment.lastAttempt < payment.delay) {
    return false; // não é hora de tentar ainda
  }

  payment.attempts++;
  payment.lastAttempt = now;
  
  logger.info(`Processing queued payment ${payment.id}, attempt ${payment.attempts}/${payment.maxRetries}`);

  // Verificar health dos processadores
  const { p1, p2 } = await healthCheck();
  
  // Definir ordem de prioridade: default primeiro, depois fallback
  const processorsToTry: Array<{url: string, type: 'default' | 'fallback'}> = [];
  
  if (p1) {
    processorsToTry.push({
      url: 'http://payment-processor-1:8080/payments',
      type: 'default'
    });
  }
  if (p2) {
    processorsToTry.push({
      url: 'http://payment-processor-2:8080/payments', 
      type: 'fallback'
    });
  }
  
  // Se nenhum healthy, tentar ambos mesmo assim (manter ordem de prioridade)
  if (processorsToTry.length === 0) {
    processorsToTry.push(
      {
        url: 'http://payment-processor-1:8080/payments',
        type: 'default'
      },
      {
        url: 'http://payment-processor-2:8080/payments',
        type: 'fallback'
      }
    );
  }
  
  // Tentar processadores na ordem de prioridade
  for (const processor of processorsToTry) {
    const result = await makeQueueRequest(processor.url, {
      correlationId: payment.correlationId,
      amount: payment.amount,
      requestedAt: payment.requestedAt
    }, logger);
    
    if (result.success) {
      logger.info(`Queued payment ${payment.id} processed successfully on ${processor.type} after ${payment.attempts} attempts`);
      queueStats.processed++;
      
      // 🎯 REGISTRAR NO SUMMARY COM O PROCESSOR CORRETO
      try {
        // Import dinâmico para evitar circular dependency
        const summaryModule = await import('./summary.js');
        await summaryModule.registerPayment(processor.type, payment.amount);
        logger.info(`Registered queued payment ${payment.id} as ${processor.type}: R$ ${payment.amount}`);
      } catch (error) {
        logger.error(`Failed to register queued payment ${payment.id}:`, error);
        // Mesmo se falhar o registro, consideramos sucesso no processamento
      }
      
      return true; // sucesso - remover da fila
    } else {
      logger.warn(`Queued payment ${payment.id} failed on ${processor.type} processor`);
    }
  }

  // Falhou em todos os processadores - verificar se deve tentar novamente
  if (payment.attempts >= payment.maxRetries) {
    logger.error(`Queued payment ${payment.id} failed permanently after ${payment.attempts} attempts on all processors`);
    queueStats.failed++;
    return true; // remover da fila (falha permanente)
  }

  // Aumentar delay para próxima tentativa (exponential backoff)
  payment.delay = Math.min(
    payment.delay * QUEUE_BACKOFF_MULTIPLIER, 
    QUEUE_MAX_DELAY
  );
  
  queueStats.retries++;
  logger.warn(`Queued payment ${payment.id} failed on all available processors, will retry in ${payment.delay}ms`);
  
  return false; // manter na fila para retry
}

// Iniciar processador da fila - OTIMIZADO PARA RECURSOS LIMITADOS
function startQueueProcessor() {
  if (queueProcessorRunning) return;
  
  queueProcessorRunning = true;
  
  const processQueue = async () => {
    // Auto-shutdown se fila vazia por muito tempo (economizar recursos)
    if (paymentQueue.length === 0) {
      if (Date.now() - lastQueueActivity > QUEUE_IDLE_THRESHOLD) {
        console.log('Queue processor stopping due to inactivity');
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
        console.error(`Error processing queued payment ${payment.id}:`, error);
        remainingPayments.unshift(payment); // manter na fila em caso de erro
      }
    }
    
    paymentQueue = remainingPayments;
    
    if (processedInBatch > 0) {
      console.log(`Queue batch processed: ${processedInBatch} payments, ${paymentQueue.length} remaining`);
    }
    
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
