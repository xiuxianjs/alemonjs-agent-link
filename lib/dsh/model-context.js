// src/dsh/model-context.ts
const modelContext = (model) => `【当前运行信息】当前请求使用的模型 ID：${JSON.stringify(model)}。这是配置的标识，不保证服务商实际路由的底层版本。当前原生图片输入也交给这个主模型；是否成功识别以实际输入和结果为准。有人明确询问本机器人的模型时据此回答，不说完全看不到配置，也不推断别人的机器人配置。不要主动播报模型信息。`;

export { modelContext };