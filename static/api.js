export async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(path, opts);
  } catch (error) {
    throw new Error("无法连接服务，请确认后端已经启动");
  }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    throw new Error((data && data.detail) || `请求失败 (${response.status})`);
  }
  return data;
}

export function uploadPdf(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (error) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error((data && data.detail) || `上传失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("上传失败，请检查服务是否在运行"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
