import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTelemetryStore, getStableChartKey } from '../store/telemetryStore';
import { TelemetryChart } from './TelemetryChart';

export const DataChartsOverlay = React.memo(() => {
    const chartConfigs = useTelemetryStore(state => state.chartConfigs);
    const activeChartCategory = useTelemetryStore(state => state.activeChartCategory);
    const setActiveChartCategory = useTelemetryStore(state => state.setActiveChartCategory);
    const isPlaying = useTelemetryStore(state => state.isPlaying);
    const referenceLapIdx = useTelemetryStore(state => state.referenceLapIdx);
    const referenceLap = useTelemetryStore(state => state.referenceLap);
    const selectedSegIdx = useTelemetryStore(state => state.selectedSegIdx);
    const selectedSectorIdx = useTelemetryStore(state => state.selectedSectorIdx);

    const moveStandardChartChannel = useTelemetryStore(state => state.moveStandardChartChannel);
    const [movingOverlayChartKey, setMovingOverlayChartKey] = React.useState<string | null>(null);
    const [isOverlaySwapping, setIsOverlaySwapping] = React.useState(false);

    const handleMoveOverlayChart = (chartKey: string, direction: 'up' | 'down') => {
        setIsOverlaySwapping(true);
        setMovingOverlayChartKey(chartKey);
        moveStandardChartChannel(chartKey, direction);
        setTimeout(() => {
            setIsOverlaySwapping(false);
            setMovingOverlayChartKey(null);
        }, 900);
    };

    React.useEffect(() => {
        setActiveChartCategory('Driver');
    }, [setActiveChartCategory]);

    const activeCharts = chartConfigs
        .filter(c => 
            c.visible && 
            (c.id !== 'Time Delta' || referenceLapIdx !== null || referenceLap !== null || (selectedSectorIdx === null && selectedSegIdx !== null)) &&
            // In this overlay (maximized HUD), we only show Driver charts per user request
            useTelemetryStore.getState().activeChartCategory === 'Driver'
        )
    const groupMaxWheelMap = React.useMemo(() => {
        return activeCharts.reduce<Record<string, number>>((acc, c) => {
            const wIdx = c.wheelIndex ?? 0;
            acc[c.id] = Math.max(acc[c.id] ?? 0, wIdx);
            return acc;
        }, {});
    }, [activeCharts]);

    return (
        <div 
            className="flex flex-col gap-1.5 w-[380px] h-full overflow-y-auto pointer-events-auto custom-scrollbar px-8 pt-4 pb-4 group"
            onWheelCapture={(e) => e.stopPropagation()}
        >

            <AnimatePresence mode="popLayout">
                {activeCharts.map((config, index) => {
                        const chartKey = `${config.id}-${config.wheelIndex ?? 'all'}`;
                        const stableKey = getStableChartKey(config);
                        const isMovingActive = movingOverlayChartKey === chartKey;

                        const wIdx = config.wheelIndex ?? 0;
                        const maxWIdx = groupMaxWheelMap[config.id] ?? 3;
                        const entryDelay = wIdx * 0.14;
                        const exitDelay = Math.max(0, maxWIdx - wIdx) * 0.14;

                        return (
                            <motion.div
                                key={`hud-${stableKey}`}
                                layout="position"
                                initial={{ opacity: 0, scale: 0.95, y: -40 }}
                                animate={{ 
                                    opacity: 1, 
                                    scale: 1, 
                                    y: 0,
                                    transition: {
                                        layout: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.52 },
                                        y: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.48, delay: entryDelay },
                                        opacity: { duration: 0.35, ease: 'easeInOut', delay: entryDelay },
                                        scale: { duration: 0.35, ease: 'easeOut', delay: entryDelay }
                                    }
                                }}
                                exit={{ 
                                    opacity: 0, 
                                    scale: 0.95, 
                                    y: -40,
                                    transition: {
                                        layout: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.52 },
                                        y: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.48, delay: exitDelay },
                                        opacity: { duration: 0.35, ease: 'easeInOut', delay: exitDelay },
                                        scale: { duration: 0.35, ease: 'easeOut', delay: exitDelay }
                                    }
                                }}
                            style={{ zIndex: isMovingActive ? 99 : 50 - index }}
                            className={`origin-right rounded-2xl ${
                                isMovingActive ? 'scale-[1.01]' : ''
                            } ${isOverlaySwapping ? 'pointer-events-none' : 'pointer-events-auto'}`}
                        >
                            <TelemetryChart 
                                channel={config.id}
                                alias={config.alias}
                                color={config.color}
                                height={activeChartCategory === 'Driver' ? 110 : 130} // Slightly taller for complex charts
                                syncKey="telemetry" 
                                unit={config.unit}
                                wheelIndex={config.wheelIndex}
                                showLapTime={false}
                                isPlaying={isPlaying}
                                onMoveUp={() => handleMoveOverlayChart(chartKey, 'up')}
                                onMoveDown={() => handleMoveOverlayChart(chartKey, 'down')}
                                canMoveUp={index > 0}
                                canMoveDown={index < activeCharts.length - 1}
                            />
                        </motion.div>
                    );
                })}
            </AnimatePresence>
        </div>
    );
});
