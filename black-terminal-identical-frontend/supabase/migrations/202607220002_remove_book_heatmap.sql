drop table if exists public.book_heatmap_collector_coverage;
drop table if exists public.book_heatmap_depth_chunks;

update public.bt_users
set allowed_indicators = array_remove(allowed_indicators, 'orderBookHeatmap')
where 'orderBookHeatmap' = any(allowed_indicators);

alter table public.bt_users alter column allowed_indicators set default array[
  'liquidationHeatmap','volatilityHeatmap','adaptiveSwingStrategy','vwap','ema20','ema50','ema200',
  'sma20','sma50','bollinger','openInterestOscillator','zScoreOscillator','waveTrendOscillator','volume'
]::text[];
