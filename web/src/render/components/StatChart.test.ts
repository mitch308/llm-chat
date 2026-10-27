import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const setOption = vi.fn();
const resize = vi.fn();
const initMock = vi.fn(() => ({ setOption, resize, dispose: vi.fn() }));

vi.mock("echarts", () => ({
  init: (...args: unknown[]) => initMock(...(args as [HTMLElement])),
}));

import StatChart from "./StatChart.vue";
import ErrorState from "./ErrorState.vue";

beforeEach(() => {
  initMock.mockClear();
  setOption.mockClear();
});

describe("StatChart", () => {
  it("mounts a container, inits echarts on it, and passes series via setOption", async () => {
    const w = mount(StatChart, {
      props: {
        chart: "bar",
        title: "本月类目支出",
        series: [
          { name: "餐饮", value: 1200 },
          { name: "交通", value: 340 },
        ],
      },
      attachTo: document.body,
    });
    await flushPromises();

    expect(w.find(".chart-container").exists()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain("本月类目支出");
    const option = setOption.mock.calls[0][0] as {
      series: { type: string; data: number[] }[];
      xAxis: { data: string[] };
    };
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].data).toEqual([1200, 340]);
    expect(option.xAxis.data).toEqual(["餐饮", "交通"]);

    w.unmount();
  });

  it("line chart maps to series type line", async () => {
    const w = mount(StatChart, {
      props: { chart: "line", title: null, series: [{ name: "周一", value: 5 }] },
      attachTo: document.body,
    });
    await flushPromises();
    const option = setOption.mock.calls[0][0] as { series: { type: string }[] };
    expect(option.series[0].type).toBe("line");
    w.unmount();
  });
});

describe("ErrorState retry", () => {
  it("emits retry when the retryable button is clicked", async () => {
    const w = mount(ErrorState, {
      props: { message: "网络异常", retryable: true },
    });
    expect(w.text()).toContain("网络异常");
    await w.find("button").trigger("click");
    expect(w.emitted("retry")).toHaveLength(1);
  });

  it("hides the button when not retryable", () => {
    const w = mount(ErrorState, { props: { message: "失败", retryable: false } });
    expect(w.find("button").exists()).toBe(false);
  });
});
