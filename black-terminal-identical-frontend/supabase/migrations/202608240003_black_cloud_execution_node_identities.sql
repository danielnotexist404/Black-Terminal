begin;

alter table public.black_cloud_nodes
  drop constraint if exists black_cloud_nodes_node_id_check;

alter table public.black_cloud_nodes
  add constraint black_cloud_nodes_node_id_check
  check (node_id ~ '^BLACK_CLOUD_(DEMO_|MAINNET_)?NODE_[0-9]{2}$');

comment on constraint black_cloud_nodes_node_id_check on public.black_cloud_nodes is
  'Allows the original execution node identity plus environment-isolated Demo and Mainnet execution nodes.';

commit;
