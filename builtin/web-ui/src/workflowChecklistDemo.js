export const WORKFLOW_CHECKLIST_DEMO_ACTION = {
  key: "release-readiness",
  source: "demo",
  title: "Likee V5.63 发布前检查",
  status: "running",
  checklist: {
    schemaVersion: 1,
    completionPolicy: "all_required",
    document: { title: "发布前专项自测清单" },
    items: [
      {
        key: "login-smoke-test",
        title: "登录与首页冒烟测试",
        required: true,
        detail: {
          summary: "确认新包的登录、冷启动和首页核心内容可正常使用。",
          sections: [
            { key: "precondition", title: "前置条件", content: "安装最新测试包，并准备一个正常测试账号。" },
            { key: "steps", title: "执行步骤", content: ["冷启动应用", "完成账号登录", "进入首页并上下滑动", "重新启动确认登录态保留"] },
            { key: "expected", title: "预期结果", content: "无崩溃、白屏或异常弹窗，首页内容正常加载。" },
          ],
        },
        state: { status: "passed", note: "Android 测试包验证通过", evidence: [], version: "demo:1" },
      },
      {
        key: "publish-video",
        title: "发布视频并核对宽高",
        required: true,
        evidenceRequired: true,
        detail: {
          summary: "覆盖竖屏视频发布链路，核对协议宽高与最终成片一致。",
          sections: [
            { key: "data", title: "测试数据", content: ["竖屏 1080×1920 视频", "横屏 1920×1080 视频"] },
            { key: "steps", title: "执行步骤", content: ["选择视频并进入编辑页", "完成裁剪后发布", "查看请求中的 width/height", "播放最终成片"] },
            { key: "expected", title: "预期结果", content: "协议宽高、旋转方向与最终成片保持一致。" },
          ],
        },
        state: { status: "pending", note: "", evidence: [], version: "demo:1" },
      },
      {
        key: "jenkins-package",
        title: "确认 Jenkins 构建产物",
        required: true,
        detail: {
          summary: "确认构建成功，并验证安装包与二维码可以访问。",
          sections: [
            { key: "checks", title: "检查项", content: ["Build Result 为 SUCCESS", "packageUrl 可下载", "qrUrl 可扫码"] },
          ],
        },
        state: { status: "blocked", note: "等待 Jenkins 构建完成", evidence: [], version: "demo:1" },
      },
      {
        key: "metrics-observation",
        title: "观察核心指标",
        required: false,
        detail: { summary: "发布后观察崩溃率、登录成功率和视频发布成功率。" },
        state: { status: "pending", note: "", evidence: [], version: "demo:1" },
      },
    ],
  },
};

export function withWorkflowChecklistProgress(action) {
  const items = action?.checklist?.items || [];
  const completedStatuses = new Set(["passed", "skipped"]);
  const required = items.filter((item) => item.required !== false);
  const completed = items.filter((item) => completedStatuses.has(item.state?.status)).length;
  const requiredCompleted = required.filter((item) => completedStatuses.has(item.state?.status)).length;
  return {
    ...action,
    checklist: {
      ...action.checklist,
      progress: {
        total: items.length,
        completed,
        required: required.length,
        requiredCompleted,
        percent: items.length ? Math.round((completed / items.length) * 100) : 0,
        ready: required.length > 0 && requiredCompleted === required.length,
      },
    },
  };
}
