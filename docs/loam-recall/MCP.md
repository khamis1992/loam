# Loam Recall MCP

Stdio JSON-RPC server. It does not run the gardener.

```bash
node --import tsx src/mcp/recallServer.ts --db C:\path\to\manus.db
```

Windows launcher: `bin\loam-recall-mcp.cmd --db C:\path\to\manus.db`.

Writes stay off unless `LOAM_RECALL_MCP_WRITE=1`. The `legal-alarraf` scope is hidden unless `LOAM_RECALL_MCP_LEGAL=1`.

Cursor client snippet:

```json
{
  "mcpServers": {
    "loam-recall": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp/recallServer.ts", "--db", "C:\\Users\\khamis\\Desktop\\loam-recall-wt\\data\\manus.db"]
    }
  }
}
```
