import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTelemetryStore, CATEGORY_CHART_CONFIGS, getStableChartKey } from '../store/telemetryStore';
import type { ChartConfig } from '../types';
import { TelemetryChart } from './TelemetryChart';
import { Plus, X, Sparkles, RotateCcw, AlertTriangle, Search } from 'lucide-react';
import { Tooltip } from './ui/Tooltip';

interface CustomBetaCanvasProps {
    isPlaying?: boolean;
}

export const CustomBetaCanvas: React.FC<CustomBetaCanvasProps> = ({ isPlaying = false }) => {
    const customBetaChartConfigs = useTelemetryStore(state => state.customBetaChartConfigs);
    const resetCustomBetaChartConfigs = useTelemetryStore(state => state.resetCustomBetaChartConfigs);
    const moveCustomBetaChartChannel = useTelemetryStore(state => state.moveCustomBetaChartChannel);
    const reorderCustomBetaChartConfigs = useTelemetryStore(state => state.reorderCustomBetaChartConfigs);
    const addCustomBetaChartChannel = useTelemetryStore(state => state.addCustomBetaChartChannel);
    const removeCustomBetaChartChannel = useTelemetryStore(state => state.removeCustomBetaChartChannel);
    const updateCustomBetaChartChannelColor = useTelemetryStore(state => state.updateCustomBetaChartChannelColor);
    const resetCustomBetaChartChannelColor = useTelemetryStore(state => state.resetCustomBetaChartChannelColor);

    const groupMaxWheelMap = useMemo(() => {
        return customBetaChartConfigs.reduce<Record<string, number>>((acc, c) => {
            const wIdx = c.wheelIndex ?? 0;
            acc[c.id] = Math.max(acc[c.id] ?? 0, wIdx);
            return acc;
        }, {});
    }, [customBetaChartConfigs]);

    const [movingChartKey, setMovingChartKey] = useState<string | null>(null);
    const [isSwapping, setIsSwapping] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);

    const handleMoveCustomChart = (index: number, direction: 'up' | 'down', key: string) => {
        setIsSwapping(true);
        setMovingChartKey(key);
        moveCustomBetaChartChannel(index, direction);
        setTimeout(() => {
            setIsSwapping(false);
            setMovingChartKey(null);
        }, 900);
    };
    const [addModalMounted, setAddModalMounted] = useState(false);
    const [isAddModalClosing, setIsAddModalClosing] = useState(false);
    const [addModalSearchQuery, setAddModalSearchQuery] = useState('');

    const [showResetConfirmModal, setShowResetConfirmModal] = useState(false);
    const [modalMounted, setModalMounted] = useState(false);
    const [isResetConfirmClosing, setIsResetConfirmClosing] = useState(false);

    const handleOpenAddModal = () => {
        setShowAddModal(true);
        setIsAddModalClosing(false);
        setAddModalSearchQuery('');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setAddModalMounted(true);
            });
        });
    };

    const handleCloseAddModal = () => {
        setAddModalMounted(false);
        setIsAddModalClosing(true);
        setTimeout(() => {
            setShowAddModal(false);
            setIsAddModalClosing(false);
        }, 280);
    };

    // Drag & Drop State
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [activeDragIndex, setActiveDragIndex] = useState<number | null>(null);

    const handleOpenResetModal = () => {
        setShowResetConfirmModal(true);
        setIsResetConfirmClosing(false);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setModalMounted(true);
            });
        });
    };

    const handleCloseResetModal = () => {
        setModalMounted(false);
        setIsResetConfirmClosing(true);
        setTimeout(() => {
            setShowResetConfirmModal(false);
            setIsResetConfirmClosing(false);
        }, 280);
    };

    const handleConfirmReset = () => {
        resetCustomBetaChartConfigs();
        handleCloseResetModal();
    };

    // Collect all available master channels from CATEGORY_CHART_CONFIGS
    const allAvailableChannels: ChartConfig[] = React.useMemo(() => {
        const list: ChartConfig[] = [];
        const seenKeys = new Set<string>();

        Object.values(CATEGORY_CHART_CONFIGS).forEach(catConfigs => {
            catConfigs.forEach(config => {
                const key = `${config.id}-${config.wheelIndex ?? 'all'}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    list.push(config);
                }
            });
        });
        return list;
    }, []);

    const activeKeys = new Set(customBetaChartConfigs.map(c => `${c.id}-${c.wheelIndex ?? 'all'}`));

    const filteredAddChannels = React.useMemo(() => {
        if (!addModalSearchQuery.trim()) return allAvailableChannels;
        const query = addModalSearchQuery.toLowerCase();
        return allAvailableChannels.filter(c => {
            const name = (c.alias || c.id).toLowerCase();
            return name.includes(query) || c.id.toLowerCase().includes(query);
        });
    }, [allAvailableChannels, addModalSearchQuery]);

    const getRGBAColor = (hexStr?: string, alpha: number = 1) => {
        if (!hexStr) return `rgba(59, 130, 246, ${alpha})`;
        if (hexStr.startsWith('rgba') || hexStr.startsWith('rgb')) return hexStr;
        const hex = hexStr.replace('#', '');
        if (hex.length === 6) {
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        return hexStr;
    };

    return (
        <div className="flex flex-col gap-4 w-full">
            {/* Toolbar Action Bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#1a1a1e]/80 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-[0_4px_20px_rgba(0,0,0,0.4)]">
                <div className="flex items-center gap-2.5">
                    <div className="p-1.5 bg-purple-500/15 rounded-lg border border-purple-400/30 text-purple-300">
                        <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-black uppercase tracking-wider text-white">Custom Telemetry Workspace</span>
                        <span className="text-[10px] font-bold text-gray-500 bg-white/5 px-2 py-0.5 rounded-full border border-white/10 font-mono">
                            {customBetaChartConfigs.length} {customBetaChartConfigs.length === 1 ? 'channel' : 'channels'} active
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={handleOpenAddModal}
                        className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all shadow-[0_0_12px_rgba(168,85,247,0.4)] flex items-center gap-1.5 cursor-pointer active:scale-95"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Channel</span>
                    </button>
                    <Tooltip text="Reset Canvas Layout" position="bottom">
                        <button
                            onClick={handleOpenResetModal}
                            className="p-1.5 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white rounded-xl text-xs transition-all border border-white/10 cursor-pointer active:scale-95"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                    </Tooltip>
                </div>
            </div>

            {/* Empty Canvas State */}
            {customBetaChartConfigs.length === 0 && (
                <div className="flex flex-col items-center justify-center p-12 bg-white/5 border border-dashed border-white/10 rounded-2xl text-center">
                    <p className="text-gray-400 font-bold mb-2">Canvas is currently empty</p>
                    <p className="text-xs text-gray-500 mb-4">Click below to add your first telemetry channel to this custom layout.</p>
                    <button
                        onClick={handleOpenAddModal}
                        className="px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-500 transition-all cursor-pointer"
                    >
                        + Add First Channel
                    </button>
                </div>
            )}

            {/* Custom Chart Cards */}
            <AnimatePresence mode="popLayout" initial={false}>
                {customBetaChartConfigs.map((config, index) => {
                        const key = `${config.id}-${config.wheelIndex ?? 'all'}`;
                        const stableKey = getStableChartKey(config);
                        const isDragging = draggedIndex === index;
                        const isDragOver = dragOverIndex === index;
                        const isMovingActive = movingChartKey === key;

                        const wIdx = config.wheelIndex ?? 0;
                        const maxWIdx = groupMaxWheelMap[config.id] ?? 3;
                        const entryDelay = wIdx * 0.14;
                        const exitDelay = Math.max(0, maxWIdx - wIdx) * 0.14;

                        return (
                            <motion.div
                                key={stableKey}
                                layout="position"
                                initial={{ opacity: 0, scale: 0.95, y: -50 }}
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
                                    y: -50,
                                    transition: {
                                        layout: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.52 },
                                        y: { type: 'tween', ease: [0.16, 1, 0.3, 1], duration: 0.48, delay: exitDelay },
                                        opacity: { duration: 0.35, ease: 'easeInOut', delay: exitDelay },
                                        scale: { duration: 0.35, ease: 'easeOut', delay: exitDelay }
                                    }
                                }}
                            draggable={activeDragIndex === index}
                            onDragStart={() => setDraggedIndex(index)}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragOverIndex(index);
                            }}
                            onDrop={() => {
                                if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
                                    reorderCustomBetaChartConfigs(draggedIndex, dragOverIndex);
                                }
                                setDraggedIndex(null);
                                setDragOverIndex(null);
                                setActiveDragIndex(null);
                            }}
                            onDragEnd={() => {
                                setDraggedIndex(null);
                                setDragOverIndex(null);
                                setActiveDragIndex(null);
                            }}
                            style={{ zIndex: isMovingActive ? 99 : 50 - index }}
                            className={`relative group/customcard rounded-2xl ${
                                isMovingActive ? 'scale-[1.01]' : ''
                            } ${isSwapping ? 'pointer-events-none' : 'pointer-events-auto'} ${
                                isDragging ? 'opacity-40 scale-[0.99] border border-dashed border-purple-500/50' : 'opacity-100'
                            } ${isDragOver ? 'ring-2 ring-purple-500/60 ring-offset-2 ring-offset-black/50' : ''}`}
                        >
                            <TelemetryChart
                                channel={config.id}
                                alias={config.alias}
                                color={config.color}
                                height={config.height}
                                syncKey="telemetry"
                                unit={config.unit}
                                wheelIndex={config.wheelIndex}
                                isPlaying={isPlaying}
                                showLapTime={false}
                                onRemove={() => removeCustomBetaChartChannel(key)}
                                onMoveUp={() => handleMoveCustomChart(index, 'up', key)}
                                onMoveDown={() => handleMoveCustomChart(index, 'down', key)}
                                canMoveUp={index > 0}
                                canMoveDown={index < customBetaChartConfigs.length - 1}
                                onDragHandleMouseDown={() => setActiveDragIndex(index)}
                                onDragHandleMouseLeave={() => { if (draggedIndex === null) setActiveDragIndex(null); }}
                                onColorChange={(newColor) => updateCustomBetaChartChannelColor(key, newColor)}
                                onColorReset={() => resetCustomBetaChartChannelColor(key)}
                            />
                        </motion.div>
                    );
                })}
            </AnimatePresence>

            {/* Add Channel Modal */}
            {showAddModal && createPortal(
                <div
                    onClick={handleCloseAddModal}
                    className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 transition-all duration-300 ease-out ${
                        addModalMounted && !isAddModalClosing
                            ? 'bg-black/60 backdrop-blur-md opacity-100'
                            : 'bg-black/0 backdrop-blur-none opacity-0 pointer-events-none'
                    }`}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className={`w-full max-w-2xl bg-[#1c1d26]/95 border border-white/20 rounded-[2rem] p-6 sm:p-7 shadow-[0_25px_60px_rgba(0,0,0,0.6),0_0_35px_rgba(168,85,247,0.2)] flex flex-col gap-5 relative z-[10000] backdrop-blur-2xl transition-all duration-300 cubic-bezier(0.16,1,0.3,1) transform ${
                            addModalMounted && !isAddModalClosing
                                ? 'opacity-100 scale-100 translate-y-0'
                                : 'opacity-0 scale-90 translate-y-4'
                        }`}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between pb-3.5 border-b border-white/10">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-purple-500/20 rounded-2xl border border-purple-400/40 text-purple-300 shadow-[0_0_15px_rgba(168,85,247,0.25)]">
                                    <Plus className="w-5 h-5 text-purple-300" />
                                </div>
                                <div>
                                    <h3 className="text-base font-black uppercase text-white tracking-wider">Add Telemetry Channel</h3>
                                    <p className="text-xs text-gray-300 mt-0.5">Select channels to add to your custom canvas layout</p>
                                </div>
                            </div>
                            <button
                                onClick={handleCloseAddModal}
                                className="p-2.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all glass-container rounded-full border border-white/10 group/close cursor-pointer"
                            >
                                <X size={20} className="group-hover/close:rotate-90 transition-transform duration-300" />
                            </button>
                        </div>

                        {/* Search Input Bar */}
                        <div className="relative w-full">
                            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-purple-400" />
                            <input
                                type="text"
                                placeholder="Search telemetry channels..."
                                value={addModalSearchQuery}
                                onChange={(e) => setAddModalSearchQuery(e.target.value)}
                                className="w-full bg-white/10 hover:bg-white/15 focus:bg-white/15 border border-white/15 focus:border-purple-400/70 rounded-xl py-2.5 pl-10 pr-3 text-xs text-white placeholder-gray-400 outline-none transition-all font-mono shadow-inner"
                            />
                        </div>

                        {/* Channel Options Grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[380px] overflow-y-auto custom-scrollbar pr-1">
                            {filteredAddChannels.length === 0 ? (
                                <div className="col-span-2 text-center py-8 text-xs font-semibold text-gray-400 italic">
                                    No telemetry channels match "{addModalSearchQuery}"
                                </div>
                            ) : (
                                filteredAddChannels.map(item => {
                                    const key = `${item.id}-${item.wheelIndex ?? 'all'}`;
                                    const isAdded = activeKeys.has(key);
                                    const itemColor = item.color || '#3b82f6';

                                    return (
                                        <button
                                            key={key}
                                            disabled={isAdded}
                                            onClick={() => {
                                                addCustomBetaChartChannel(item);
                                                handleCloseAddModal();
                                            }}
                                            className={`p-3.5 rounded-xl border text-left transition-all flex items-center justify-between cursor-pointer group/item ${
                                                isAdded
                                                    ? 'bg-white/[0.04] border-white/5 opacity-40 cursor-not-allowed'
                                                    : 'bg-white/[0.08] hover:bg-white/[0.14] border-white/15 hover:border-purple-400/50 shadow-sm active:scale-[0.98]'
                                            }`}
                                            style={!isAdded ? {
                                                borderColor: getRGBAColor(itemColor, 0.4),
                                                boxShadow: `0 0 14px ${getRGBAColor(itemColor, 0.18)}`
                                            } : {}}
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                {/* Color Swatch Circle */}
                                                <div
                                                    className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0 shadow-sm transition-transform group-hover/item:scale-110"
                                                    style={{ backgroundColor: itemColor, boxShadow: `0 0 8px ${getRGBAColor(itemColor, 0.6)}` }}
                                                />
                                                <div className="min-w-0">
                                                    <div className="text-xs font-bold text-white truncate">{item.alias || item.id}</div>
                                                    <div className="text-[10px] text-gray-300 font-mono">{item.unit ? `Unit: ${item.unit}` : 'Dimensionless'}</div>
                                                </div>
                                            </div>
                                            {isAdded ? (
                                                <span className="text-[10px] text-purple-300 font-bold shrink-0 ml-2 uppercase tracking-wider">Added</span>
                                            ) : (
                                                <Plus className="w-4 h-4 text-purple-400 shrink-0 ml-2 group-hover/item:scale-125 transition-transform" />
                                            )}
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Reset Confirmation Modal */}
            {showResetConfirmModal && (
                <div
                    onClick={handleCloseResetModal}
                    className={`fixed inset-0 z-[600] flex items-center justify-center p-4 transition-all duration-300 ease-out ${
                        modalMounted && !isResetConfirmClosing
                            ? 'bg-black/60 backdrop-blur-md opacity-100'
                            : 'bg-black/0 backdrop-blur-none opacity-0 pointer-events-none'
                    }`}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className={`bg-[#1c1d26]/95 border border-white/20 rounded-[2rem] p-6 w-full max-w-sm shadow-[0_25px_60px_rgba(0,0,0,0.6),0_0_35px_rgba(168,85,247,0.25)] flex flex-col items-center text-center gap-4 transition-all duration-300 cubic-bezier(0.16,1,0.3,1) backdrop-blur-2xl transform ${
                            modalMounted && !isResetConfirmClosing
                                ? 'opacity-100 scale-100 translate-y-0'
                                : 'opacity-0 scale-90 translate-y-4'
                        }`}
                    >
                        <div className="p-3 bg-purple-500/20 rounded-full border border-purple-400/30 text-purple-300">
                            <AlertTriangle className="w-6 h-6 text-purple-400 animate-pulse" />
                        </div>

                        <div>
                            <h3 className="text-base font-black uppercase text-white tracking-wider">Reset Custom Beta Canvas?</h3>
                            <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
                                This will restore your scratchpad canvas layout to the default <span className="text-purple-300 font-bold">Speed</span>, <span className="text-purple-300 font-bold">Throttle</span>, and <span className="text-purple-300 font-bold">Brake</span> charts.
                            </p>
                        </div>

                        <div className="flex items-center justify-end gap-3 w-full mt-2">
                            <button
                                onClick={handleCloseResetModal}
                                className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 text-gray-300 rounded-xl text-xs font-bold transition-all border border-white/10 cursor-pointer active:scale-95"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmReset}
                                className="flex-1 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all shadow-[0_0_15px_rgba(168,85,247,0.4)] cursor-pointer active:scale-95"
                            >
                                Reset Layout
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
