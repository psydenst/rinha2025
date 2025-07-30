#!/bin/bash

# ==========================================
# SCRIPT DE TESTE DE ESTRESSE E COMPARAÇÃO
# ==========================================

set -e  # Para o script se algum comando falhar

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# URLs
YOUR_API="http://localhost:9999"
RINHA_API_1="http://localhost:8001"
RINHA_API_2="http://localhost:8002"
RINHA_TOKEN="123"

# Contadores
TOTAL_PAYMENTS=0
SUCCESS_COUNT=0
ERROR_COUNT=0

echo -e "${BLUE}🚀 INICIANDO TESTE DE ESTRESSE E COMPARAÇÃO${NC}"
echo "=============================================="

# Função para gerar UUID v4
generate_uuid() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    else
        python3 -c "import uuid; print(str(uuid.uuid4()))"
    fi
}

# Função para gerar timestamp ISO
generate_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

# Função para limpar todos os dados
cleanup_all() {
    echo -e "${YELLOW}🧹 Limpando dados anteriores...${NC}"
    
    # Limpar processors da rinha
    curl -s -X POST -H "X-Rinha-Token: $RINHA_TOKEN" "$RINHA_API_1/admin/purge-payments" > /dev/null
    curl -s -X POST -H "X-Rinha-Token: $RINHA_TOKEN" "$RINHA_API_2/admin/purge-payments" > /dev/null
    
    # Limpar Redis da sua API (se você tiver um endpoint para isso)
    # Ou reiniciar os containers
    echo "Reiniciando sua API para limpar Redis..."
    docker-compose restart redis api1 api2 > /dev/null 2>&1
    sleep 3
    
    echo -e "${GREEN}✅ Limpeza concluída${NC}"
}

# Função para enviar um pagamento
send_payment() {
    local correlation_id=$(generate_uuid)
    local amount=$(echo "scale=2; $RANDOM / 100" | bc)  # Valor aleatório entre 0-327.67
    local timestamp=$(generate_timestamp)
    
    local response=$(curl -s -X POST "$YOUR_API/payments" \
        -H "Content-Type: application/json" \
        -d "{
            \"correlationId\": \"$correlation_id\",
            \"amount\": $amount,
            \"requestedAt\": \"$timestamp\"
        }" 2>/dev/null)
    
    if echo "$response" | grep -q "payment processed successfully"; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        echo -e "${GREEN}✅${NC} Payment $TOTAL_PAYMENTS: R$ $amount"
    else
        ERROR_COUNT=$((ERROR_COUNT + 1))
        echo -e "${RED}❌${NC} Payment $TOTAL_PAYMENTS: ERROR - $response"
    fi
    
    TOTAL_PAYMENTS=$((TOTAL_PAYMENTS + 1))
}

# Função para obter summary da sua API
get_your_summary() {
    curl -s "$YOUR_API/payments-summary" | jq '.'
}

# Função para obter summary consolidado da rinha
get_rinha_summary() {
    local summary1=$(curl -s -H "X-Rinha-Token: $RINHA_TOKEN" "$RINHA_API_1/admin/payments-summary")
    local summary2=$(curl -s -H "X-Rinha-Token: $RINHA_TOKEN" "$RINHA_API_2/admin/payments-summary")
    
    local total_requests=$(echo "$summary1 $summary2" | jq -s '.[0].totalRequests + .[1].totalRequests')
    local total_amount=$(echo "$summary1 $summary2" | jq -s '.[0].totalAmount + .[1].totalAmount')
    local total_fee=$(echo "$summary1 $summary2" | jq -s '.[0].totalFee + .[1].totalFee')
    
    echo "{"
    echo "  \"totalRequests\": $total_requests,"
    echo "  \"totalAmount\": $total_amount,"
    echo "  \"totalFee\": $total_fee"
    echo "}"
}

# Função para comparar resultados
compare_results() {
    echo -e "\n${BLUE}📊 COMPARANDO RESULTADOS${NC}"
    echo "=========================="
    
    echo -e "\n${YELLOW}Sua API:${NC}"
    local your_summary=$(get_your_summary)
    echo "$your_summary"
    
    echo -e "\n${YELLOW}Rinha (Consolidado):${NC}"
    local rinha_summary=$(get_rinha_summary)
    echo "$rinha_summary"
    
    # Extrair totais da sua API (somando default + fallback)
    local your_total_requests=$(echo "$your_summary" | jq '.default.totalRequests + .fallback.totalRequests')
    local your_total_amount=$(echo "$your_summary" | jq '.default.totalAmount + .fallback.totalAmount')
    
    # Extrair totais da rinha
    local rinha_total_requests=$(echo "$rinha_summary" | jq '.totalRequests')
    local rinha_total_amount=$(echo "$rinha_summary" | jq '.totalAmount')
    
    echo -e "\n${BLUE}🔍 ANÁLISE:${NC}"
    echo "Your API  - Requests: $your_total_requests, Amount: R$ $your_total_amount"
    echo "Rinha API - Requests: $rinha_total_requests, Amount: R$ $rinha_total_amount"
    
    # Verificar consistência
    if [ "$your_total_requests" = "$rinha_total_requests" ] && \
       [ "$(echo "$your_total_amount == $rinha_total_amount" | bc)" = "1" ]; then
        echo -e "${GREEN}✅ DADOS CONSISTENTES!${NC}"
        return 0
    else
        echo -e "${RED}❌ INCONSISTÊNCIA DETECTADA!${NC}"
        return 1
    fi
}

# Função principal de teste
run_stress_test() {
    local num_payments=${1:-10}
    local concurrent=${2:-1}
    
    echo -e "\n${BLUE}⚡ EXECUTANDO TESTE DE ESTRESSE${NC}"
    echo "Pagamentos: $num_payments"
    echo "Concorrência: $concurrent"
    echo "=========================="
    
    # Reset contadores
    TOTAL_PAYMENTS=0
    SUCCESS_COUNT=0
    ERROR_COUNT=0
    
    if [ "$concurrent" -gt 1 ]; then
        # Teste concorrente
        echo "Enviando $num_payments pagamentos concorrentemente..."
        for ((i=1; i<=num_payments; i++)); do
            send_payment &
            if (( i % concurrent == 0 )); then
                wait  # Espera o batch atual terminar
            fi
        done
        wait  # Espera todos os processos terminarem
    else
        # Teste sequencial
        for ((i=1; i<=num_payments; i++)); do
            send_payment
        done
    fi
    
    echo -e "\n${BLUE}📈 RESULTADOS DO TESTE:${NC}"
    echo "Total enviados: $TOTAL_PAYMENTS"
    echo "Sucessos: $SUCCESS_COUNT"
    echo "Erros: $ERROR_COUNT"
    echo "Taxa de sucesso: $(echo "scale=2; $SUCCESS_COUNT * 100 / $TOTAL_PAYMENTS" | bc)%"
}

# Menu principal
show_menu() {
    echo -e "\n${BLUE}🔧 MENU DE OPÇÕES:${NC}"
    echo "1. Limpar todos os dados"
    echo "2. Teste rápido (5 pagamentos)"
    echo "3. Teste médio (50 pagamentos)"
    echo "4. Teste pesado (200 pagamentos)"
    echo "5. Teste concorrente (100 pagamentos, 10 concurrent)"
    echo "6. Comparar resultados apenas"
    echo "7. Teste personalizado"
    echo "8. Loop contínuo de comparação"
    echo "0. Sair"
    echo -n "Escolha uma opção: "
}

# Função para loop contínuo
continuous_comparison() {
    echo -e "${BLUE}🔄 MODO COMPARAÇÃO CONTÍNUA (Ctrl+C para sair)${NC}"
    echo "Enviando 1 pagamento a cada 2 segundos e comparando..."
    
    while true; do
        send_payment
        sleep 1
        compare_results
        echo -e "\n${YELLOW}Aguardando 2 segundos...${NC}"
        sleep 2
        echo "----------------------------------------"
    done
}

# Script principal
main() {
    # Verificar dependências
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${RED}❌ jq não encontrado. Instale com: brew install jq${NC}"
        exit 1
    fi
    
    if ! command -v bc >/dev/null 2>&1; then
        echo -e "${RED}❌ bc não encontrado. Instale com: brew install bc${NC}"
        exit 1
    fi
    
    # Verificar se as APIs estão rodando
    if ! curl -s "$YOUR_API/payments-summary" >/dev/null 2>&1; then
        echo -e "${RED}❌ Sua API não está respondendo em $YOUR_API${NC}"
        exit 1
    fi
    
    while true; do
        show_menu
        read -r choice
        
        case $choice in
            1)
                cleanup_all
                ;;
            2)
                cleanup_all
                run_stress_test 5 1
                compare_results
                ;;
            3)
                cleanup_all
                run_stress_test 50 1
                compare_results
                ;;
            4)
                cleanup_all
                run_stress_test 200 1
                compare_results
                ;;
            5)
                cleanup_all
                run_stress_test 100 10
                compare_results
                ;;
            6)
                compare_results
                ;;
            7)
                echo -n "Número de pagamentos: "
                read -r num
                echo -n "Concorrência (1 para sequencial): "
                read -r conc
                cleanup_all
                run_stress_test "$num" "$conc"
                compare_results
                ;;
            8)
                cleanup_all
                continuous_comparison
                ;;
            0)
                echo -e "${GREEN}👋 Até logo!${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}❌ Opção inválida${NC}"
                ;;
        esac
        
        echo -e "\n${YELLOW}Pressione Enter para continuar...${NC}"
        read -r
    done
}

# Executar apenas se chamado diretamente
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
