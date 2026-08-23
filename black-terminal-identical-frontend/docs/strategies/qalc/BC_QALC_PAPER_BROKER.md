# BC-QALC Paper Broker

Lifecycle: Created → Active after submission+ack latency → Partially Filled/Filled, Cancelled or Expired. Only one one-sided quote may exist.

PostOnly crossing is rejected. Quote lifetime defaults to 500 ms. Cancel becomes effective only after configured cancel latency, so flow arriving in the race window remains eligible for conservative simulation.

Passive fills use actual opposing public trades after acknowledgement and queue consumption. Exits are conservatively modelled as taker executions at best bid/ask plus latency/slippage. All executions carry maker/taker assumption and fee.

The Paper broker imports no provider exchange adapter and has no network order method.
