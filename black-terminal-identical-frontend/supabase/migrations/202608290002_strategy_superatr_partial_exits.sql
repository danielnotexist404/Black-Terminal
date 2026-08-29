begin;

alter table public.strategy_paper_positions
  add column if not exists initial_quantity numeric,
  add column if not exists take_profit_plan jsonb not null default '[]'::jsonb,
  add column if not exists filled_take_profit_ids text[] not null default '{}'::text[];

update public.strategy_paper_positions set initial_quantity=quantity where initial_quantity is null;

alter table public.strategy_paper_positions
  add constraint strategy_paper_positions_initial_quantity_check
  check (initial_quantity is null or initial_quantity > 0),
  add constraint strategy_paper_positions_take_profit_plan_check
  check (jsonb_typeof(take_profit_plan)='array');

create or replace function public.black_core_paper_partial_close_position(
  p_position_id uuid,
  p_owner_user_id uuid,
  p_exit_price numeric,
  p_exit_quantity numeric,
  p_exit_fee numeric,
  p_funding numeric,
  p_exit_reason text,
  p_exit_signal_key text,
  p_take_profit_id text,
  p_closed_at timestamptz
)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  position_row public.strategy_paper_positions;
  paper public.strategy_paper_accounts;
  close_quantity numeric;
  remaining_quantity numeric;
  quantity_fraction numeric;
  released_margin numeric;
  allocated_entry_fee numeric;
  gross numeric;
  net numeric;
  next_equity numeric;
  next_peak numeric;
  next_drawdown numeric;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'strategy service identity required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('paper-position:'||p_position_id::text,0));
  select * into position_row from public.strategy_paper_positions where id=p_position_id and owner_user_id=p_owner_user_id and closed_at is null for update;
  if position_row.id is null or p_exit_quantity<=0 or p_exit_price<=0 then return false; end if;
  if p_take_profit_id is not null and p_take_profit_id=any(position_row.filled_take_profit_ids) then return false; end if;
  select * into paper from public.strategy_paper_accounts where id=position_row.paper_account_id for update;
  close_quantity:=least(position_row.quantity,p_exit_quantity);
  quantity_fraction:=close_quantity/position_row.quantity;
  remaining_quantity:=greatest(0,position_row.quantity-close_quantity);
  released_margin:=position_row.margin_used*quantity_fraction;
  allocated_entry_fee:=position_row.entry_fee*quantity_fraction;
  gross:=(p_exit_price-position_row.entry_price)*close_quantity*case when position_row.side='LONG' then 1 else -1 end;
  net:=gross-allocated_entry_fee-p_exit_fee-p_funding;
  next_equity:=greatest(0,paper.demo_equity+gross-p_exit_fee-p_funding);
  next_peak:=greatest(paper.peak_equity,next_equity);
  next_drawdown:=case when next_peak>0 then greatest(paper.maximum_drawdown_percent,(next_peak-next_equity)/next_peak*100) else paper.maximum_drawdown_percent end;

  update public.strategy_paper_positions set
    quantity=case when remaining_quantity>0 then remaining_quantity else position_row.quantity end,
    mark_price=p_exit_price,
    margin_used=case when remaining_quantity>0 then greatest(0,position_row.margin_used-released_margin) else 0 end,
    entry_fee=case when remaining_quantity>0 then greatest(0,position_row.entry_fee-allocated_entry_fee) else 0 end,
    unrealized_pnl=case when remaining_quantity>0 then (p_exit_price-position_row.entry_price)*remaining_quantity*case when position_row.side='LONG' then 1 else -1 end else 0 end,
    filled_take_profit_ids=case when p_take_profit_id is null then position_row.filled_take_profit_ids else array_append(position_row.filled_take_profit_ids,p_take_profit_id) end,
    closed_at=case when remaining_quantity<=0 then p_closed_at else null end,
    updated_at=now()
  where id=position_row.id;

  insert into public.strategy_automation_executions(strategy_id,owner_user_id,paper_account_id,mode,symbol,side,quantity,price,fee,funding,realized_pnl,signal_key,executed_at,safe_metadata)
  values(position_row.strategy_id,p_owner_user_id,position_row.paper_account_id,'PAPER',position_row.symbol,case when position_row.side='LONG' then 'SELL' else 'BUY' end,close_quantity,p_exit_price,p_exit_fee,p_funding,net,p_exit_signal_key,p_closed_at,jsonb_build_object('adapter','PAPER','exitReason',p_exit_reason,'takeProfitId',p_take_profit_id,'partial',remaining_quantity>0));
  insert into public.strategy_automation_trades(strategy_id,owner_user_id,paper_account_id,mode,symbol,side,quantity,entry_price,exit_price,gross_pnl,fees,funding,net_pnl,entry_signal_key,exit_reason,opened_at,closed_at)
  values(position_row.strategy_id,p_owner_user_id,position_row.paper_account_id,'PAPER',position_row.symbol,position_row.side,close_quantity,position_row.entry_price,p_exit_price,gross,allocated_entry_fee+p_exit_fee,p_funding,net,position_row.signal_key,p_exit_reason,position_row.opened_at,p_closed_at);
  update public.strategy_paper_accounts set
    demo_equity=next_equity,
    available_balance=greatest(0,available_balance+released_margin+gross-p_exit_fee-p_funding),
    used_strategy_capital=greatest(0,used_strategy_capital-released_margin),
    realized_pnl=realized_pnl+net,
    unrealized_pnl=(select coalesce(sum(unrealized_pnl),0) from public.strategy_paper_positions where paper_account_id=position_row.paper_account_id and closed_at is null),
    fees=fees+p_exit_fee,funding=funding+p_funding,peak_equity=next_peak,maximum_drawdown_percent=next_drawdown,state_version=state_version+1
  where id=position_row.paper_account_id;
  insert into public.strategy_automation_audit_events(owner_user_id,strategy_id,event_type,message,safe_metadata)
  values(p_owner_user_id,position_row.strategy_id,'PAPER_PARTIAL_TAKE_PROFIT_FILLED','A deterministic SuperATR partial take-profit was filled.',jsonb_build_object('entrySignalKey',position_row.signal_key,'exitSignalKey',p_exit_signal_key,'takeProfitId',p_take_profit_id,'quantity',close_quantity,'remainingQuantity',remaining_quantity,'netPnl',net));
  return true;
end;
$$;

revoke all on function public.black_core_paper_partial_close_position(uuid,uuid,numeric,numeric,numeric,numeric,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.black_core_paper_partial_close_position(uuid,uuid,numeric,numeric,numeric,numeric,text,text,text,timestamptz) to service_role;

commit;
