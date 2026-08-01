begin;

-- Market Maker Heatmap is administrator-only by default. Administrators can
-- explicitly grant it to individual users through bt_users.allowed_indicators.
update public.bt_users
set allowed_indicators = array_remove(allowed_indicators, 'volatilityHeatmap'),
    active_indicators = array_remove(active_indicators, 'volatilityHeatmap')
where role <> 'admin'
  and (
    'volatilityHeatmap' = any(allowed_indicators)
    or 'volatilityHeatmap' = any(active_indicators)
  );

update public.bt_users
set allowed_indicators = array_append(allowed_indicators, 'volatilityHeatmap')
where role = 'admin'
  and not ('volatilityHeatmap' = any(allowed_indicators));

alter table public.bt_users alter column allowed_indicators set default array[
  'liquidationHeatmap','adaptiveSwingStrategy','vwap','ema20','ema50','ema200',
  'sma20','sma50','bollinger','openInterestOscillator','zScoreOscillator','waveTrendOscillator','volume'
]::text[];

commit;
