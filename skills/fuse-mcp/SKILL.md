---
name: fuse-mcp
description: >-
  Conecta e interage com o ERP Fuse pelo protocolo MCP (Model Context Protocol):
  contexto empresarial, alternância de empresas da holding, catálogo de produtos/serviços,
  participantes (clientes e fornecedores), financeiro (contas a pagar, contas a receber,
  caixas e bancos, criação e liquidação de títulos) e relatórios/KPIs executivos.
  Use quando o pedido for consultar ou lançar dados no Fuse ERP, instalar ou ligar o MCP
  do Fuse, ou quando mencionarem fuse_get_context, financas_*, participantes_*,
  dashboard_kpis_get ou a ponte mcp-bridge.
---

# MCP do Fuse ERP

O agente atua **estritamente em nome do usuário** cujo token de API está configurado no servidor MCP. A segurança do sistema opera sob o princípio de **Zero Privilege Escalation** através de **Dupla Trava (Double-Lock)**:

$$\text{Acesso Efetivo} = \text{Escopo do Token} \cap \text{Empresas da Holding} \cap \text{RBAC do Usuário no Fuse}$$

O agente só enxerga e opera nas empresas em que o usuário tem acesso e permissão ativa. Nunca inventa IDs, valores monetários ou dados cadastrais (CPF/CNPJ).

Antes de cada operação, o cliente MCP lê o schema vivo das ferramentas (`tools/list`). Os campos obrigatórios documentados abaixo representam o contrato oficial da API.

---

## 1. Instalar e Conectar o MCP

Execute este procedimento apenas quando o usuário solicitar a instalação, conexão ou configuração do MCP do Fuse, ou quando as ferramentas ainda não estiverem disponíveis. Se o servidor `fuse` já responder a `tools/list`, não instale outro.

1. **Obter a Chave de API:**
   - O usuário deve acessar o painel do Fuse em **Minha Conta** (`/dashboard/user/account`) > aba **Chaves de API & MCP**.
   - Criar uma nova chave com os escopos desejados e copiar o token gerado (`fuse_live_...`).
   - **IMPORTANTE:** Nunca invente um token, nunca o commite, e nunca o exiba por extenso no chat ou em arquivos versionados.

2. **Host da API:**
   - Em produção: URL da API Fuse (ex: `https://api.fuse.brim.com.br` ou a URL do ambiente).
   - Em desenvolvimento local: `http://localhost:3334`.

3. **Ambiente de Execução:**
   - É necessário ter `bun` ou `node` instalado.
   - A ponte oficial é o arquivo `scripts/mcp-bridge.ts` localizado junto a esta skill.
   - Na pasta que contém o `scripts/` (ou seja, a pasta da skill `fuse-mcp`), execute `bun install` ou `npm install` uma vez para instalar a dependência `@modelcontextprotocol/sdk`.

4. **Configuração nos Clientes de IA:**

### Cursor (`.cursor/mcp.json` ou `~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "fuse": {
      "command": "bun",
      "args": ["run", "/CAMINHO/ABSOLUTO/skills/fuse-mcp/scripts/mcp-bridge.ts"],
      "env": {
        "FUSE_API_URL": "http://localhost:3334",
        "FUSE_TOKEN": "fuse_live_..."
      }
    }
  }
}
```
*(Se estiver usando Node.js, utilize `"command": "npx"` e `"args": ["-y", "tsx", "/CAMINHO/ABSOLUTO/skills/fuse-mcp/scripts/mcp-bridge.ts"]`)*

### Claude Desktop (`claude_desktop_config.json`)
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fuse": {
      "command": "bun",
      "args": ["run", "/CAMINHO/ABSOLUTO/skills/fuse-mcp/scripts/mcp-bridge.ts"],
      "env": {
        "FUSE_API_URL": "http://localhost:3334",
        "FUSE_TOKEN": "fuse_live_..."
      }
    }
  }
}
```

5. Recarregue os servidores MCP no cliente e confirme a descoberta das ferramentas executando `fuse_get_context`.

---

## 2. Fluxo de Trabalho & Contexto Empresarial

Antes de qualquer consulta ou mutação de dados:

1. **Identificar o Contexto:**
   - Execute `fuse_get_context` para confirmar:
     - Qual é a holding ativa.
     - Qual é a empresa corrente (`idEmpresa`, `nome`, `cnpj`).
     - Quais os escopos habilitados no token.
2. **Alternar Empresa (se necessário):**
   - Se a instrução do usuário referir-se a outra empresa da holding, consulte `fuse_list_empresas` e utilize `fuse_switch_empresa` com o `idEmpresa` desejado.
   - Toda tool subsequente executará no escopo da empresa ativa.

---

## 3. Catálogo de Ferramentas (Tools)

### Grupo 1: Contexto e Gestão de Empresas

| Tool | Escopo Obrigatório | Argumentos | Descrição |
| :--- | :--- | :--- | :--- |
| `fuse_get_context` | `context:read` | Nenhum | Retorna usuário emissor, holding e empresa ativa. |
| `fuse_list_empresas` | `context:read` | Nenhum | Lista todas as empresas da holding com permissão ativa. |
| `fuse_switch_empresa` | `context:read` | `idEmpresa` (number) | Alterna a empresa ativa da sessão para as próximas operações. |

### Grupo 2: Cadastros Básicos

| Tool | Escopo Obrigatório | Argumentos | Descrição |
| :--- | :--- | :--- | :--- |
| `participantes_list` | `cadastros:read` | `termo` (opcional), `cpfCnpj` (opcional), `tipo` (opcional: `CLIENTE`, `FORNECEDOR`, `AMBOS`), `limite`, `pagina` | Pesquisa clientes, fornecedores e transportadoras. |
| `participantes_get` | `cadastros:read` | `id` (number) | Retorna ficha cadastral completa com endereço e contatos. |
| `produtos_servicos_list` | `cadastros:read` | `termo` (opcional), `tipo` (opcional: `PRODUTO`, `SERVICO`), `limite`, `pagina` | Consulta o catálogo de itens comercializados e códigos. |

### Grupo 3: Financeiro & Fluxo de Caixa

| Tool | Escopo Obrigatório | Argumentos | Descrição |
| :--- | :--- | :--- | :--- |
| `financas_contas_receber_list` | `financas:read` | `status` (opcional: `PENDENTE`, `LIQUIDADO`, `TODOS`), `dataVencimentoInicio`, `dataVencimentoFim`, `idCliente`, `limite`, `pagina` | Consulta carteira de títulos a receber. |
| `financas_contas_pagar_list` | `financas:read` | `status` (opcional), `dataVencimentoInicio`, `dataVencimentoFim`, `idFornecedor`, `limite`, `pagina` | Consulta títulos e compromissos a pagar. |
| `financas_caixas_bancos_list` | `financas:read` | Nenhum | Lista contas bancárias ativas e saldos disponíveis. |
| `financas_titulo_create` | `financas:write` | `tipo` (`RECEBER` ou `PAGAR`), `descricao`, `valorOriginal` (number), `dataVencimento` (`YYYY-MM-DD`), `idParticipante`, `idPlanoContas` (opcional), `historico` (opcional) | Emite um novo título financeiro a pagar ou receber. |
| `financas_titulo_liquidar` | `financas:write` | `idTitulo` (number), `valorPago` (number), `dataLiquidacao` (`YYYY-MM-DD`), `idContaBancaria` (number), `acrescimos` (opcional), `descontos` (opcional) | Efetua a liquidação/baixa financeira de um título. |

### Grupo 4: Relatórios & KPIs Executivos

| Tool | Escopo Obrigatório | Argumentos | Descrição |
| :--- | :--- | :--- | :--- |
| `dashboard_kpis_get` | `relatorios:read` | `dataInicio` (opcional), `dataFim` (opcional) | Retorna resumo executivo: faturamento, despesas, inadimplência e saldo operacional. |
| `relatorios_inadimplencia` | `relatorios:read` | `diasAtrasoMinimo` (opcional: default 1), `limite` (opcional) | Lista títulos vencidos ordenados por atraso e valor acumulado. |

---

## 4. Diretrizes de Segurança & Boas Práticas

1. **Transparência antes de Mutação:**
   - Antes de executar operações de escrita (`financas_titulo_create` ou `financas_titulo_liquidar`), informe expressamente ao usuário o valor, o participante e a empresa em que o lançamento ocorrerá.
2. **Tratamento de Permissão:**
   - Se o servidor responder com erro de permissão (`Acesso negado: o token não possui o escopo...` ou `o usuário não possui permissão na tela...`), informe claramente qual tela ou escopo está ausente no perfil do usuário no Fuse. Não tente forçar chamadas repetidas sem autorização.
3. **Respeito à Moeda e Datas:**
   - Valores monetários são numéricos decimais em Reais (BRL, ex: `1250.50`).
   - Datas seguem o padrão ISO `YYYY-MM-DD`.
4. **Isolamento de Segredos:**
   - O token `fuse_live_...` jamais deve ser enviado como mensagem de texto para o modelo nem gravado em logs locais.
