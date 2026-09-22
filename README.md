# Fuse MCP

Skill para agentes de Inteligência Artificial interagirem diretamente com o ERP **Fuse** através do Model Context Protocol (MCP): consulta de contexto, alternância de empresas da holding, catálogo de produtos e serviços, cadastro de participantes (clientes e fornecedores), financeiro (contas a pagar, contas a receber, saldos de caixas e bancos, criação e liquidação de títulos) e relatórios/KPIs executivos.

```bash
npx skills add BRIM-Sistemas/fuse-mcp
```

Depois solicite ao seu agente (Cursor, Claude Desktop, Antigravity) para instalar ou conectar o MCP do Fuse. A skill inclui a ponte stdio (`scripts/mcp-bridge.ts`) e as instruções para configurar o `.cursor/mcp.json` ou `claude_desktop_config.json`.

O token `fuse_live_...` é gerado pelo próprio usuário no Fuse em **Minha Conta** (`/dashboard/user/account`) → **Chaves de API & MCP** e **nunca** deve ser versionado neste repositório.

O agente passa a atuar estritamente em nome do usuário cujo token está configurado no servidor, com segurança garantida por **Dupla Trava (Double-Lock)**: Escopo do Token $\cap$ Tenant/Empresa $\cap$ Permissões RBAC ativas no Fuse. A skill não inclui chaves, tokens nem dados sensíveis.

Página: https://skills.sh/BRIM-Sistemas/fuse-mcp
