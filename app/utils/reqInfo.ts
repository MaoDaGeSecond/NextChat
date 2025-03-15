// 用于处理reqInfo的工具函数

// 全局reqInfo对象
let reqInfo: any = {};

/**
 * 从localStorage获取reqInfo
 * @returns reqInfo对象
 */
export function getReqInfo(): any {
  if (!Object.keys(reqInfo).length) {
    try {
      const reqStr = localStorage.getItem("edt-gpt-req-info");
      if (reqStr) {
        reqInfo = JSON.parse(reqStr);
      }
    } catch (e) {
      console.error("Failed to parse reqInfo from localStorage", e);
    }
  }
  return reqInfo;
}

/**
 * 将reqInfo添加到headers中
 * @param originalHeaders 原始headers对象
 * @returns 添加了reqInfo的新headers对象
 */
export function addReqInfoToHeaders(
  originalHeaders: Record<string, string>,
): Record<string, string> {
  const info = getReqInfo();
  return {
    ...originalHeaders,
    reqInfo: JSON.stringify(info),
  };
}
