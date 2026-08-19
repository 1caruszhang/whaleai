import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PublishOrderScreenshot from "./PublishOrderScreenshot";

// 票 09：渠道回传截图是用户来源 HTML，必须经现有 sanitize 栈渲染。
// 本文件钉住恶意内容被清洗、良性内容保留；jsdom 不执行脚本，断言落在
// DOM 结构层面（脚本节点不存在、事件属性被剥除、危险协议被剥除）。

describe("PublishOrderScreenshot", () => {
  it("strips injected script tags and event handlers", () => {
    const { container } = render(
      <PublishOrderScreenshot
        html={
          '<div><p>已发布截图正文</p><script>alert("pwned")</script>' +
          '<img src="https://cdn.example/shot.png" onerror="alert(1)">' +
          "</div>"
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    // 良性内容保留：文本与图片仍在。
    expect(screen.getByText("已发布截图正文")).toBeInTheDocument();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example/shot.png",
    );
  });

  it("strips javascript: links and inline handlers on anchors", () => {
    const { container } = render(
      <PublishOrderScreenshot
        html={
          '<a href="javascript:alert(1)" onclick="steal()">查看原文</a>' +
          '<a href="https://news.example/article">真实链接</a>'
        }
      />,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBeNull();
    expect(links[0].getAttribute("onclick")).toBeNull();
    expect(links[1].getAttribute("href")).toBe("https://news.example/article");
    expect(screen.getByText("真实链接")).toBeInTheDocument();
  });

  it("strips iframe/object embeds that could smuggle active content", () => {
    const { container } = render(
      <PublishOrderScreenshot
        html={
          '<iframe src="https://evil.example/frame"></iframe>' +
          '<object data="https://evil.example/payload"></object>' +
          "<p>正文仍在</p>"
        }
      />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
    expect(screen.getByText("正文仍在")).toBeInTheDocument();
  });

  it("keeps plain screenshots text inside the projection container", () => {
    const { container } = render(
      <PublishOrderScreenshot
        html="<p>收录截图：关键词排名第 3 位</p><p><strong>来源：渠道回传</strong></p>"
      />,
    );
    expect(
      container.querySelector("[data-publish-order-screenshot]"),
    ).not.toBeNull();
    expect(
      container.textContent?.includes("收录截图：关键词排名第 3 位"),
    ).toBe(true);
    expect(container.textContent?.includes("来源：渠道回传")).toBe(true);
  });
});
