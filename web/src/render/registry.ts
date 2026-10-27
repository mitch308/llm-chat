import { h, type Component } from "vue";
import { defineRegistry } from "@json-render/vue";
import BillConfirmCard from "./components/BillConfirmCard.vue";
import BillList from "./components/BillList.vue";
import BillItem from "./components/BillItem.vue";
import Metric from "./components/Metric.vue";
import StatChart from "./components/StatChart.vue";
import NewsList from "./components/NewsList.vue";
import NewsItem from "./components/NewsItem.vue";
import EmptyState from "./components/EmptyState.vue";
import ErrorState from "./components/ErrorState.vue";

type Ctx = { props: Record<string, unknown> };

/** catalog 定义在 server（catalog.prompt 用）；web 侧仅做 类型→组件 映射。 */
const built = defineRegistry({ data: {} } as never, {
  components: {
    BillConfirmCard: (ctx: Ctx) => h(BillConfirmCard, ctx.props),
    BillList: (ctx: Ctx) => h(BillList, ctx.props),
    BillItem: (ctx: Ctx) => h(BillItem, ctx.props),
    Metric: (ctx: Ctx) => h(Metric, ctx.props),
    StatChart: (ctx: Ctx) => h(StatChart, ctx.props),
    NewsList: (ctx: Ctx) => h(NewsList, ctx.props),
    NewsItem: (ctx: Ctx) => h(NewsItem, ctx.props),
    EmptyState: (ctx: Ctx) => h(EmptyState, ctx.props),
    ErrorState: (ctx: Ctx) => h(ErrorState, ctx.props),
  },
});

export const registry = built.registry as unknown as Record<string, Component>;
