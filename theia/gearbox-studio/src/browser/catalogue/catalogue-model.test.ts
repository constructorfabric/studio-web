// From Gearbox Studio, constructorfabric/gearbox#14 (`ide/tests/ux/catalogue-model.spec.ts`),
// moved from Playwright to jest: the model is pure.
import {buildCatalogue,searchScore,type CatalogueNode} from "./catalogue-model";
import {rowKey,type Row} from "../../common/protocol";
import type {ExtensionPointDecl} from "../../common/generated/ExtensionPointDecl";
import type {GearDescriptor} from "../../common/generated/GearDescriptor";

const point=(spec:string,trait_ident="SharedTrait")=>({spec,trait_ident,sdk_lib:"test_sdk",sdk:{crate_name:"test-sdk",lib:"test_sdk",path:"sdk"}}) as unknown as ExtensionPointDecl;
function gear(id:string,extra:Partial<GearDescriptor>={}): Row {
  return {kind:"projected",gear:{id,display_name:id,category:"system",source:"checkout",gdl_path:`${id}/gear.gdl`,maturity:"preview",visibility:"public",package:{crate_name:id,lib:id,path:id},...extra} as GearDescriptor};
}
const idOf=(n:CatalogueNode)=>n.row?.kind==="projected"?n.row.gear.id:undefined;
function flatten(nodes:readonly CatalogueNode[]):CatalogueNode[]{return nodes.flatMap(n=>[n,...flatten(n.children)]);}
const host=gear("auth",{display_name:"Authentication",extension_points:[point("auth-spec")]});
const plugin=gear("oidc",{display_name:"OIDC",description:"Sign users in with enterprise identity",implements:{spec:"auth-spec"}});

describe("catalogue presentation model",()=>{
 test("grouped view puts plugins under their exact extension point",()=>{
  const m=buildCatalogue([host,plugin],{grouped:true});
  expect(m.nodes[0]!.children.map(idOf)).toEqual(["auth"]);
  expect(m.nodes[0]!.children[0]!.children[0]!.children[0]!.row).toBe(plugin);
  expect(m.count).toBe(2);
 });
 test("flat view exposes every entity once",()=>{
  const m=buildCatalogue([host,plugin],{grouped:false});
  expect(m.nodes[0]!.children.map(idOf)).toEqual(["auth","oidc"]);
  expect(flatten(m.nodes).some(n=>n.kind==="point")).toBe(false);
 });
 test("shared plugin occurrences have different keys and one result identity",()=>{
  const second=gear("second",{extension_points:[point("auth-spec")]});
  const m=buildCatalogue([host,second,plugin],{grouped:true,search:"OIDC"});
  const appearances=flatten(m.nodes).filter(n=>n.row===plugin);
  expect(appearances).toHaveLength(2);
  expect(new Set(appearances.map(n=>n.key)).size).toBe(2);
  expect(m.count).toBe(1); expect(m.nodes[0]!.count).toBe(1);
  expect(appearances.every(n=>n.row && rowKey(n.row)===rowKey(plugin))).toBe(true);
 });
 test("matching trait names do not imply matching sockets",()=>{
  const wrong=gear("wrong",{extension_points:[point("other-spec")]});
  const m=buildCatalogue([wrong,plugin],{grouped:true});
  expect(flatten(m.nodes).filter(n=>n.row===plugin)[0]!.host).toBeUndefined();
  expect(m.nodes.some(n=>n.label==="Without a matching host")).toBe(true);
 });
 test("multi-point hosts keep plugin families separate",()=>{
  const multi=gear("chat",{extension_points:[point("audit","Audit"),point("policy","Policy")]});
  const audit=gear("audit",{implements:{spec:"audit"}}),policy=gear("policy",{implements:{spec:"policy"}});
  const root=buildCatalogue([multi,audit,policy],{grouped:true}).nodes[0]!.children[0]!;
  expect(root.children.map(p=>p.children.map(idOf))).toEqual([["audit"],["policy"]]);
 });
 test("a plugin-host has a root and a leaf occurrence without recursive expansion",()=>{
  const hybrid=gear("provider",{implements:{spec:"auth-spec"},extension_points:[point("source")]});
  const child=gear("source",{implements:{spec:"source"}});
  const m=buildCatalogue([host,hybrid,child],{grouped:true});
  const copies=flatten(m.nodes).filter(n=>n.row===hybrid);
  expect(copies).toHaveLength(2);
  expect(copies.find(n=>n.host)!.children).toHaveLength(0);
  expect(copies.find(n=>!n.host)!.children[0]!.children[0]!.row).toBe(child);
  expect(m.count).toBe(3);
 });
 test("orphans stay visible with a provisional loading explanation",()=>{
  const m=buildCatalogue([plugin],{grouped:true,loading:true});
  expect(m.nodes[0]!.label).toBe("Without a matching host");
  expect(m.nodes[0]!.hint).toContain("still being determined");
  expect(m.nodes[0]!.children[0]!.row).toBe(plugin);
 });
 test("a hybrid without a parent occurs once and retains its sockets",()=>{
  const hybrid=gear("hybrid",{implements:{spec:"missing"},extension_points:[point("auth-spec")]});
  const m=buildCatalogue([hybrid,plugin],{grouped:true});
  expect(flatten(m.nodes).filter(n=>n.row===hybrid)).toHaveLength(1);
  expect(m.nodes[0]!.label).toBe("Without a matching host");
 });
 test("description search exposes plugin and context ancestors without counting them",()=>{
  const m=buildCatalogue([host,plugin],{grouped:true,search:"enterprise identity"});
  expect(m.count).toBe(1);
  expect(m.nodes[0]!.children[0]!.context).toBe(true);
  expect(flatten(m.nodes).find(n=>n.row===plugin)!.context).toBe(false);
 });
 test("search words span fields, scenarios and case",()=>{
  const row=gear("parser",{description:"Read documents",scenarios:[{text:"Import CSV files",done:true}]});
  expect(searchScore(row,"DOCUMENTS csv")).toBeDefined();
  expect(searchScore(row,"documents missing")).toBeUndefined();
 });
 test("interface names, SDK names and GTS specs are searchable",()=>{
  expect(searchScore(host,"SharedTrait")).toBeDefined();
  expect(searchScore(host,"test_sdk")).toBeDefined();
  expect(searchScore(plugin,"auth-spec")).toBeDefined();
 });
 test("plugin category filtering retains a host from another category as context",()=>{
  const separate=gear("oidc",{category:"identity",implements:{spec:"auth-spec"}});
  const m=buildCatalogue([host,separate],{grouped:true,category:"identity"});
  expect(m.count).toBe(1);expect(m.nodes[0]!.children[0]!.row).toBe(host);
 });
 test("contextual Add plugin searches only the fixed host and socket",()=>{
  const other=gear("unrelated",{implements:{spec:"other"}});
  const m=buildCatalogue([host,plugin,other],{grouped:true,host:"auth",point:"auth-spec"});
  expect(m.total).toBe(1);expect(m.count).toBe(1);
  expect(flatten(m.nodes).some(n=>n.row===other)).toBe(false);
 });
 test("exact ID or name ranks above description matches",()=>{
  const text=gear("aaa",{description:"Supports OIDC"});
  expect(buildCatalogue([text,host,plugin],{grouped:false,search:"OIDC"}).nodes[0]!.children[0]!.row).toBe(plugin);
 });
 test("pending rows stay visible without invented compatibility",()=>{
  const pending:Row={kind:"pending",gear:{source:"checkout",gdl_path:"pending/gear.gdl",display_name:"Pending",category:"system"} as Extract<Row,{kind:"pending"}>["gear"]};
  const m=buildCatalogue([pending,host,plugin],{grouped:true});
  expect(flatten(m.nodes).filter(n=>n.row===pending)).toHaveLength(1);
 });
 test("late host projection relocates a plugin without changing its entity key",()=>{
  const before=flatten(buildCatalogue([plugin],{grouped:true,loading:true}).nodes).find(n=>n.row===plugin)!;
  const after=flatten(buildCatalogue([host,plugin],{grouped:true}).nodes).find(n=>n.row===plugin)!;
  expect(rowKey(before.row!)).toBe(rowKey(after.row!));expect(after.host?.id).toBe("auth");
 });
});
