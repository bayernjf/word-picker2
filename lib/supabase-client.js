// Word-Picker2 Supabase 客户端
import { createClient } from '@supabase/supabase-js'

const DEFAULT_SUPABASE_URL = 'http://localhost:54321'
const DEFAULT_SUPABASE_ANON_KEY = 'your-anon-key'

// 初始化 Supabase 客户端
export function createSupabaseClient({ url, anonKey }) {
  const supabaseUrl = url || DEFAULT_SUPABASE_URL
  const supabaseKey = anonKey || DEFAULT_SUPABASE_ANON_KEY
  return createClient(supabaseUrl, supabaseKey)
}

// 单词相关 API
export const wordApi = {
  async getWords(supabase, userId, bookId) {
    let query = supabase
      .from('words')
      .select('*')
      .eq('user_id', userId)
      .eq('is_deleted', false)

    if (bookId) {
      query = query.eq('book_id', bookId)
    }

    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async createWord(supabase, word) {
    const { data, error } = await supabase
      .from('words')
      .insert(word)
      .select()

    if (error) throw error
    return data[0]
  },

  async deleteWord(supabase, wordId) {
    const { data, error } = await supabase
      .from('words')
      .update({ is_deleted: true })
      .eq('id', wordId)
      .select()

    if (error) throw error
    return data
  }
}

// 单词本相关 API
export const bookApi = {
  async getBooks(supabase, userId) {
    const { data, error } = await supabase
      .from('vocabulary_books')
      .select('*')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .order('is_sync', { ascending: false })
      .order('created_at')

    if (error) throw error
    return data
  }
}

// 同步相关 API
export const syncApi = {
  async getFullSync(supabase, userId) {
    const [booksRes, wordsRes] = await Promise.all([
      bookApi.getBooks(supabase, userId),
      wordApi.getWords(supabase, userId)
    ])
    
    return {
      books: booksRes,
      words: wordsRes
    }
  }
}
