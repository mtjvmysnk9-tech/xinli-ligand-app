// Function 入口：平台注入的 _qoder/backend.mjs 提供私有数据库客户端。
// forwardApplicationCredentials 保留本应用自己的 Cookie；不使用平台身份，也没有身份回退。
import { createDatabaseClient, createSiteContext, errorResponse } from './_qoder/backend.mjs';
import { createApplication } from './router.mjs';
import { SITE_ORIGIN } from './config.mjs';

const handle = createApplication({ db: createDatabaseClient(), origin: SITE_ORIGIN });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request, { forwardApplicationCredentials: true });
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
