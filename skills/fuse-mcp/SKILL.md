---
name: fuse-mcp
description: >-
  Conecta e interage com o ERP Fuse pelo protocolo MCP (Model Context Protocol):
  contexto empresarial (empresas que a chave acessa), catálogo de produtos/serviços,
  participantes (clientes e fornecedores), financeiro (contas a pagar, contas a receber,
  caixas e bancos, centros de custo, criação, liquidação e cancelamento de títulos) e
  relatórios/KPIs executivos.
  Use quando o pedido for consultar ou lançar dados no Fuse ERP, instalar ou ligar o MCP
  do Fuse, ou quando mencionarem fuse_get_context, financas_*, participantes_*,
  dashboard_kpis_get ou a ponte mcp-bridge.
---

# MCP do Fuse ERP

O agente atua **estritamente em nome do usuário** cujo token de API está configurado no servidor MCP. A segurança do sistema opera sob o princípio de **Zero Privilege Escalation** através de **Dupla Trava (Double-Lock)**:

$$\text{Acesso Efetivo} = \text{Grant da Chave (holding, escopo, empresa)} \cap \text{Acesso atual do usuário à empresa} \cap \text{RBAC do Usuário no Fuse}$$

O agente só enxerga e opera nas empresas concedidas na chave em que o usuário ainda tem acesso e permissão ativa. Nunca inventa IDs, valores monetários ou dados cadastrais (CPF/CNPJ).

Antes de cada operação, o cliente MCP lê o schema vivo das ferramentas (`tools/list`). Os campos obrigatórios documentados abaixo representam o contrato oficial da API.

---

## 1. Instalar e Conectar o MCP

Execute este procedimento apenas quando o usuário solicitar a instalação, conexão ou configuração do MCP do Fuse, ou quando as ferramentas ainda não estiverem disponíveis. Se o servidor `fuse` já responder a `tools/list`, não instale outro.

1. **Obter a Chave de API:**
   - O usuário deve acessar o painel do Fuse em **Minha Conta** (`/dashboard/user/account`) > aba **Chaves de API & MCP**.
   - Criar uma nova chave escolhendo, por holding, os escopos e as empresas exatas que ela poderá acessar, e copiar o token gerado (`fuse_live_...`).
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

A chave pertence ao **usuário** e, para cada holding, concede escopos e uma lista **exata** de empresas. Não existe "empresa ativa" nem troca de empresa na sessão.

1. **Descobrir onde pode operar:** execute `fuse_get_context` (usuário, chave e, por holding, os escopos e as empresas que a chave acessa agora) ou `fuse_list_empresas` (opcionalmente filtrando por `escopo`).
2. **Informar a empresa em cada chamada:** toda ferramenta de negócio recebe o argumento `empresaId` (número). Sem ele, se a chave conceder exatamente uma empresa para aquela ferramenta, ela é usada e a resposta traz `_contexto` dizendo qual; se conceder várias, a ferramenta devolve `EMPRESA_OBRIGATORIA` com a lista — pergunte ao usuário em qual empresa operar.
3. **Acesso efetivo por chamada:** grant da chave (holding, escopo, empresa) ∩ usuário ainda tem acesso à empresa ∩ permissão do usuário na tela correspondente do Fuse. Não há atalho de administrador.

---

## 3. Catálogo de Ferramentas (Tools)

Os nomes de argumentos abaixo são o contrato atual; o cliente MCP também lê o schema vivo em `tools/list`. Todas as ferramentas de negócio aceitam `empresaId`.

### Grupo 1: Contexto (sem escopo)

| Tool | Argumentos | Descrição |
| :--- | :--- | :--- |
| `fuse_get_context` | Nenhum | Usuário, chave e, por holding, escopos e empresas acessíveis agora. Use no início. |
| `fuse_list_empresas` | `escopo` (opcional: `financas:read`, `financas:write`, `cadastros:read`, `relatorios:read`) | Empresas que a chave acessa agora, com holding, CNPJ e escopos. Use o `empresaId` retornado nas demais ferramentas. |

### Grupo 2: Cadastros

| Tool | Escopo | Tela exigida | Argumentos | Descrição |
| :--- | :--- | :--- | :--- | :--- |
| `participantes_list` | `cadastros:read` | `cadastro.participantes` | `busca` (nome, razão social ou CPF/CNPJ), `limite` (padrão 20, máx. 100), `pagina` | Pesquisa clientes, fornecedores e parceiros. |
| `participantes_get` | `cadastros:read` | `cadastro.participantes` | `id` ou `uuid` | Ficha detalhada de um participante. |
| `produtos_servicos_list` | `cadastros:read` | `cadastro.catalogos` | `busca` (nome ou SKU), `tipo` (`todos`, `produto`, `servico`), `limite` | Catálogo de produtos e serviços. |

### Grupo 3: Financeiro

| Tool | Escopo | Tela exigida | Argumentos | Descrição |
| :--- | :--- | :--- | :--- | :--- |
| `financas_contas_receber_list` | `financas:read` | `financas.contasreceber` | `status` (`todos` padrão, `aberto`, `vencido`, `liquidado`, `cancelado`), `limite` (padrão 20, máx. 100), `pagina` | Títulos a receber. Retorna `id` e `uuid` de cada título. |
| `financas_contas_pagar_list` | `financas:read` | `financas.contaspagar` | mesmos de contas a receber | Títulos a pagar. |
| `financas_caixas_bancos_list` | `financas:read` | `financas.caixasbancos` | Nenhum | Contas correntes e caixas da empresa. |
| `financas_centros_custo_list` | `financas:read` | `configuracao.financas.centrocusto` | Nenhum | Centros de custo da empresa. |
| `financas_titulo_create` | `financas:write` | contas a receber ou a pagar (escrita), conforme `tipo` | **obrigatórios:** `tipo` (`cr` a receber, `cp` a pagar), `valor` (> 0), `dataVencimento` (`AAAA-MM-DD`), `historico`, `idParticipante`, `idContaCorrente`, `idCentroCusto`; opcional: `idMeioPagamento` | Cria um título em aberto. Participante, conta corrente e centro de custo precisam ser da empresa. |
| `financas_titulo_liquidar` | `financas:write` | tela do tipo do título (escrita); `financas.caixasbancos` se `idContaCorrente` for informado | **obrigatório:** `uuid`; opcionais: `dataLiquidacao` (`AAAA-MM-DD`, padrão hoje), `idContaCorrente` (padrão: a do título), `idMeioPagamento` (padrão: o do título) | Baixa o **saldo integral** que falta pagar de um título, pelo mesmo fluxo da tela (registra o pagamento e o saldo da conta). Não faz baixa parcial nem aplica juros/descontos. Recusa título já liquidado, cancelado ou com boleto ativo. Chamar de novo para o mesmo título é recusado. |
| `financas_titulo_cancelar` | `financas:write` | tela do tipo do título (escrita) | **obrigatórios:** `uuid`, `motivo`; opcional: `dataCancelamento` (`AAAA-MM-DD`, padrão hoje) | Cancela um título em aberto e **sem nenhum pagamento registrado**. Recusa título liquidado, parcialmente pago, já cancelado ou com boleto ativo. |

### Grupo 4: Relatórios & KPIs

| Tool | Escopo | Telas exigidas | Argumentos | Descrição |
| :--- | :--- | :--- | :--- | :--- |
| `dashboard_kpis_get` | `relatorios:read` | `dashboard`, `financas.contasreceber`, `financas.contaspagar` | Nenhum | Totais em aberto a receber e a pagar, vencidos e saldo previsto. |
| `relatorios_inadimplencia` | `relatorios:read` | `financas.relatorios`, `financas.contasreceber` | `limite` (padrão 50, máx. 200) | Recebíveis vencidos e não liquidados, com dias de atraso e cliente. |

---

## 4. Diretrizes de Segurança & Boas Práticas

1. **Confirmar antes de escrever:** antes de `financas_titulo_create`, `financas_titulo_liquidar` ou `financas_titulo_cancelar`, mostre ao usuário a empresa, o título (valor, vencimento, participante) e o que será feito (data e conta da baixa, ou motivo do cancelamento), e só execute depois da confirmação explícita.
2. **Identificar o título pelo `uuid`:** obtenha-o em `financas_contas_receber_list` / `financas_contas_pagar_list`; nunca invente ou adivinhe `uuid` ou ids.
3. **Operações que ficam na tela do Fuse:** estorno de pagamento, baixa parcial, juros/descontos e qualquer operação sobre título com boleto ativo (ela baixaria o boleto no banco). Quando a ferramenta recusar por um desses motivos, explique e oriente o usuário a fazer pela tela — não tente contornar.
4. **Tratamento de permissão:** erros de escopo (`a chave não concede o escopo...`) ou de tela (`o usuário não possui permissão na tela...`) indicam o que falta na chave ou no perfil do usuário. Informe claramente e não repita a chamada.
5. **Moeda e datas:** valores em reais como número decimal (ex.: `1250.50`); datas no formato `AAAA-MM-DD`.
6. **Isolamento de segredos:** o token `fuse_live_...` jamais deve ser enviado ao modelo como texto nem gravado em logs ou arquivos versionados.
