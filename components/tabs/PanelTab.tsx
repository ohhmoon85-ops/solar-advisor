'use client'

import { PANEL_DATA } from '@/lib/staticData'
import { useSolarStore } from '@/store/useStore'
import {
  BarChart, Bar, ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { calcYearlyTable } from '@/lib/calculations'

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444']

export default function PanelTab() {
  const { setActiveTab, capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears } = useSolarStore()

  const efficiencyData = PANEL_DATA.map(p => ({
    name: p.name.length > 8 ? p.name.slice(0, 8) : p.name,
    fullName: p.name,
    efficiency: parseFloat(p.efficiency.split('~')[1] ?? p.efficiency),
  }))

  const scatterData = PANEL_DATA.map((p, i) => {
    const minCost = parseFloat(p.costPerKw.split('~')[0])
    const rows20 = calcYearlyTable(capacityKw, installationType, totalCost, loanRatio, loanRate, loanYears)
    const cum20 = rows20[rows20.length - 1].cumulative
    return {
      name: p.name,
      cost: minCost,
      revenue20: Math.round(cum20 / 1000) / 10, // 억원
      color: COLORS[i],
    }
  })

  const handleSelectPanel = (index: number) => {
    setActiveTab('revenue')
  }

  return (
    <div className="space-y-4">
      {/* Panel cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {PANEL_DATA.map((panel, i) => (
          <div
            key={i}
            className={`bg-white rounded-xl border-2 p-5 cursor-pointer hover:shadow-md transition-all ${
              panel.highlight
                ? 'border-yellow-400 shadow-yellow-100 shadow-md'
                : 'border-gray-200 hover:border-blue-300'
            }`}
            onClick={() => handleSelectPanel(i)}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="font-bold text-gray-900 text-base">{panel.name}</div>
                <div className="text-2xl font-bold text-blue-600 mt-1">{panel.watt}W</div>
              </div>
              {panel.highlight && (
                <span className="bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full flex-shrink-0">
                  ⭐ 실제현장
                </span>
              )}
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex justify-between items-center py-1 border-b border-gray-100">
                <span className="text-xs text-gray-500">모듈 효율</span>
                <span className="text-sm font-semibold text-gray-800">{panel.efficiency}</span>
              </div>
              <div className="flex justify-between items-center py-1 border-b border-gray-100">
                <span className="text-xs text-gray-500">REC 가중치</span>
                <span className="text-sm font-semibold text-blue-600">{panel.recWeight}</span>
              </div>
              <div className="flex justify-between items-center py-1 border-b border-gray-100">
                <span className="text-xs text-gray-500">시공단가</span>
                <span className="text-sm font-semibold text-gray-800">{panel.costPerKw}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-xs text-gray-500">적합 설치</span>
                <span className="text-xs font-medium text-green-600 text-right">{panel.suitable}</span>
              </div>
            </div>

            <button
              onClick={e => { e.stopPropagation(); handleSelectPanel(i) }}
              className={`mt-4 w-full py-2 rounded-lg text-sm font-semibold transition-colors ${
                panel.highlight
                  ? 'bg-yellow-400 hover:bg-yellow-500 text-yellow-900'
                  : 'bg-blue-50 hover:bg-blue-100 text-blue-700'
              }`}
            >
              수익성 시뮬레이터 적용 →
            </button>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-4">패널 유형별 모듈 효율(%)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={efficiencyData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={[0, 30]} tick={{ fontSize: 11 }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={70} />
              <Tooltip formatter={(v) => [`${v}%`, '효율']} />
              <Bar dataKey="efficiency" radius={[0, 4, 4, 0]}>
                {efficiencyData.map((_, index) => (
                  <Cell key={index} fill={PANEL_DATA[index].highlight ? '#f59e0b' : COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-4">설치단가 vs 20년 누적수익</h3>
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="cost" name="설치단가" unit="만/kW" tick={{ fontSize: 11 }} label={{ value: '설치단가(만원/kW)', position: 'insideBottom', offset: -5, fontSize: 11 }} />
              <YAxis type="number" dataKey="revenue20" name="20년 누적수익" unit="억" tick={{ fontSize: 11 }} label={{ value: '20년 수익(억원)', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ payload }) => {
                if (!payload?.length) return null
                const d = payload[0]?.payload as typeof scatterData[0]
                return (
                  <div className="bg-white border border-gray-200 rounded-lg p-2 text-xs shadow">
                    <div className="font-semibold">{d.name}</div>
                    <div>설치단가: {d.cost}만원/kW~</div>
                    <div>20년 수익: {d.revenue20}억원</div>
                  </div>
                )
              }} />
              <Scatter data={scatterData}>
                {scatterData.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-2 mt-2 justify-center">
            {PANEL_DATA.map((p, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                <span className="text-xs text-gray-600">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Comparison table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">패널 전체 비교표</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-4 py-2.5 text-left font-semibold text-gray-600">모델</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">출력(W)</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">효율</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">REC가중치</th>
                <th className="px-4 py-2.5 text-center font-semibold text-gray-600">시공단가</th>
                <th className="px-4 py-2.5 text-left font-semibold text-gray-600">적합 설치</th>
              </tr>
            </thead>
            <tbody>
              {PANEL_DATA.map((p, i) => (
                <tr key={i}
                  className={`border-t border-gray-100 cursor-pointer transition-colors ${
                    p.highlight ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => handleSelectPanel(i)}
                >
                  <td className="px-4 py-2.5 font-semibold text-gray-800">
                    {p.name}
                    {p.highlight && <span className="ml-2 text-xs bg-yellow-400 text-yellow-900 px-1.5 py-0.5 rounded-full">현장</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center font-bold text-blue-600">{p.watt}</td>
                  <td className="px-4 py-2.5 text-center">{p.efficiency}</td>
                  <td className="px-4 py-2.5 text-center text-green-600 font-medium">{p.recWeight}</td>
                  <td className="px-4 py-2.5 text-center text-gray-700">{p.costPerKw}</td>
                  <td className="px-4 py-2.5 text-gray-600">{p.suitable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
