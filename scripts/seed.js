// 命令列載入庫存域示例資料：npm run seed
// 使用與服務相同的 DATA_DIR 與 Git 設定；完成後推送到遠端（如已配置）。
import { createServer } from '../src/server.js';
import { ADMIN_PRINCIPAL } from '../src/api/auth.js';
import { seedInventory } from '../src/seed/inventory.js';

const srv = await createServer({ schedulers: false });
try {
  const out = await seedInventory(srv.ctx, ADMIN_PRINCIPAL);
  console.log(`已載入示例資料：${out.subjects} 個主體，焦點主體 ${out.focus}`);
} catch (err) {
  console.error(`載入失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  await srv.close();
}
