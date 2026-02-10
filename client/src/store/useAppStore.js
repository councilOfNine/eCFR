import { create } from 'zustand'

export const useAppStore = create((set) => ({
  data: null,
  setData: (data) => set({ data }),
}))
